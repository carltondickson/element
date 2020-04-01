import ts from 'typescript'
import path from 'path'
import { Documentation, Class, Type, Member } from './Documentation'

/**
 * @param {!Array<!import('../Source')>} sources
 */
export default function checkSources(sources) {
	// special treatment for Events.js
	const classEvents = new Map()
	const eventsSource = sources.find(source => source.name() === 'Events.js')
	if (eventsSource) {
		const { Events } = require(eventsSource.filePath())
		for (const [className, events] of Object.entries(Events))
			classEvents.set(
				className,
				Array.from(Object.values(events))
					.filter(e => typeof e === 'string')
					.map((e: string) => Member.createEvent(e)),
			)
	}

	const excludeClasses = new Set([])
	const program = ts.createProgram({
		options: {
			allowJs: true,
			target: ts.ScriptTarget.ES2017,
		},
		rootNames: sources.map(source => source.filePath()),
	})
	const checker = program.getTypeChecker()
	const sourceFiles = program.getSourceFiles()

	const classes: Class[] = []
	const inheritance: Map<string, string> = new Map()
	sourceFiles.filter(x => !x.fileName.includes('node_modules')).map(x => visit(x))
	const errors = []
	const documentation = new Documentation(recreateClassesWithInheritance(classes, inheritance))

	return { errors, documentation }

	/**
	 * @param {!Array<!Class>} classes
	 * @param {!Map<string, string>} inheritance
	 * @return {!Array<!Class>}
	 */
	function recreateClassesWithInheritance(classes, inheritance) {
		const classesByName = new Map(classes.map(cls => [cls.name, cls]))
		return classes.map(cls => {
			const membersMap = new Map()
			for (let wp = cls; wp; wp = classesByName.get(inheritance.get(wp.name))) {
				for (const member of wp.membersArray) {
					// Member was overridden.
					const memberId = member.kind + ':' + member.name
					if (membersMap.has(memberId)) continue
					membersMap.set(memberId, member)
				}
			}
			return new Class(cls.name, Array.from(membersMap.values()))
		})
	}

	/**
	 * @param {!ts.Node} node
	 */
	function visit(node) {
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			// @ts-ignore
			const symbol = node.name ? checker.getSymbolAtLocation(node.name) : node.symbol
			let className = symbol.getName()

			if (className === '__class') {
				let parent = node
				// @ts-ignore
				while (parent.parent) parent = parent.parent
				// @ts-ignore
				className = path.basename(parent.fileName, '.ts')
			}
			if (className && !excludeClasses.has(className)) {
				classes.push(serializeClass(className, symbol, node))
				const parentClassName = parentClass(node)
				if (parentClassName) inheritance.set(className, parentClassName)
				excludeClasses.add(className)
			}
		}
		ts.forEachChild(node, visit)
	}

	function parentClass(classNode) {
		for (const herigateClause of classNode.heritageClauses || []) {
			for (const heritageType of herigateClause.types) {
				const parentClassName = heritageType.expression.escapedText
				return parentClassName
			}
		}
		return null
	}

	function serializeSymbol(symbol, circular = []) {
		const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
		const name = symbol.getName()
		if (symbol.valueDeclaration && symbol.valueDeclaration.dotDotDotToken) {
			const innerType = serializeType(type.aliasTypeArguments[0], circular)
			innerType.name = '...' + innerType.name
			return Member.createProperty('...' + name, innerType)
		}
		return Member.createProperty(name, serializeType(type, circular))
	}

	/**
	 * @param {!ts.ObjectType} type
	 */
	function isRegularObject(type) {
		if (type.isIntersection()) return true
		if (!type.objectFlags) return false
		if (!('aliasSymbol' in type)) return false
		if (type.getConstructSignatures().length) return false
		if (type.getCallSignatures().length) return false
		if (type.isLiteral()) return false
		if (type.isUnion()) return false

		return true
	}

	/**
	 * @param {!ts.Type} type
	 * @return {!Type}
	 */
	function serializeType(type, circular = []) {
		let typeName = checker.typeToString(type)
		if (typeName === 'any' || typeName === '{ [x: string]: string; }') typeName = 'Object'
		const nextCircular = [typeName].concat(circular)

		if (isRegularObject(type)) {
			let properties = undefined
			if (!circular.includes(typeName))
				properties = type.getProperties().map(property => serializeSymbol(property, nextCircular))
			return new Type('Object', properties)
		}
		if (type.isUnion() && typeName.includes('|')) {
			const types = type.types.map(type => serializeType(type, circular))
			const name = types.map(type => type.name).join('|')
			const properties = [].concat(...types.map(type => type.properties))
			return new Type(name.replace(/false\|true/g, 'boolean'), properties)
		}
		if (type.typeArguments) {
			const properties = []
			const innerTypeNames = []
			for (const typeArgument of type.typeArguments) {
				const innerType = serializeType(typeArgument, nextCircular)
				if (innerType.properties) properties.push(...innerType.properties)
				innerTypeNames.push(innerType.name)
			}
			if (
				innerTypeNames.length === 0 ||
				(innerTypeNames.length === 1 && innerTypeNames[0] === 'void')
			)
				return new Type(type.symbol.name)
			return new Type(`${type.symbol.name}<${innerTypeNames.join(', ')}>`, properties)
		}
		return new Type(typeName, [])
	}

	/**
	 * @param {string} className
	 * @param {!ts.Symbol} symbol
	 * @return {}
	 */
	function serializeClass(className, symbol, node) {
		/** @type {!Array<!Member>} */
		const members = classEvents.get(className) || []

		for (const [name, member] of symbol.members || []) {
			if (name.startsWith('_')) continue
			const memberType = checker.getTypeOfSymbolAtLocation(member, member.valueDeclaration)
			const signature = memberType.getCallSignatures()[0]
			if (signature) members.push(serializeSignature(name, signature))
			else members.push(serializeProperty(name, memberType))
		}

		return new Class(className, members)
	}

	/**
	 * @param {string} name
	 * @param {!ts.Signature} signature
	 */
	function serializeSignature(name, signature) {
		const parameters = signature.parameters.map(s => serializeSymbol(s))
		const returnType = serializeType(signature.getReturnType())
		return Member.createMethod(name, parameters, returnType.name !== 'void' ? returnType : null)
	}

	/**
	 * @param {string} name
	 * @param {!ts.Type} type
	 */
	function serializeProperty(name, type) {
		return Member.createProperty(name, serializeType(type))
	}
}
