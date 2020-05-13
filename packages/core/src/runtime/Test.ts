import Interceptor from '../network/Interceptor'
import { Browser } from './Browser'

import { IReporter } from '../Reporter'
import { NullReporter } from '../reporter/Null'
import { ObjectTrace } from '../utils/ObjectTrace'

import { TestObserver, NullTestObserver } from './test-observers/Observer'
import LifecycleObserver from './test-observers/Lifecycle'
import ErrorObserver from './test-observers/Errors'
import InnerObserver from './test-observers/Inner'

import { AnyErrorData, EmptyErrorData, AssertionErrorData } from './errors/Types'
import { StructuredError } from '../utils/StructuredError'

import { Step, StepType } from './Step'

import { CancellationToken } from '../utils/CancellationToken'

import { PuppeteerClientLike } from '../driver/Puppeteer'
import { ScreenshotOptions } from 'puppeteer'
import { TestSettings, ConcreteTestSettings, DEFAULT_STEP_WAIT_SECONDS } from './Settings'
import { ITest } from './ITest'
import { EvaluatedScriptLike } from './EvaluatedScriptLike'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const debug = require('debug')('element:runtime:test')

export default class Test implements ITest {
	public settings: ConcreteTestSettings
	public steps: Step[]

	public runningBrowser: Browser<Step> | null

	public requestInterceptor: Interceptor

	private testCancel: () => Promise<void> = async () => {
		return
	}

	public iteration = 0

	public failed: boolean

	get skipping(): boolean {
		return this.failed
	}

	constructor(
		public client: PuppeteerClientLike,
		public script: EvaluatedScriptLike,
		public reporter: IReporter = new NullReporter(),
		settingsOverride: TestSettings,
		public testObserverFactory: (t: TestObserver) => TestObserver = x => x,
	) {
		this.script = script

		try {
			const { settings, steps } = script
			this.settings = settings as ConcreteTestSettings
			this.steps = steps

			// Adds output for console in script
			script.bindTest(this)
		} catch (err) {
			// XXX parsing errors. Lift to StructuredError?
			throw this.script.maybeLiftError(err)
		}

		Object.assign(this.settings, settingsOverride)
		this.requestInterceptor = new Interceptor(this.settings.blockedDomains || [])
	}

	public async cancel() {
		this.failed = true
		await this.testCancel()
	}

	public async beforeRun(): Promise<void> {
		debug('beforeRun()')
		await this.script.beforeTestRun()
	}

	/**
	 * Runs the group of steps
	 * @return {Promise<void|Error>}
	 */
	public async run(iteration?: number): Promise<void> | never {
		await this.runWithCancellation(iteration || 0, new CancellationToken())
	}

	public async runWithCancellation(
		iteration: number,
		cancelToken: CancellationToken,
	): Promise<void> {
		console.assert(this.client, `client is not configured in Test`)

		const testObserver = new ErrorObserver(
			new LifecycleObserver(this.testObserverFactory(new InnerObserver(new NullTestObserver()))),
		)

		await (await this.client).reopenPage(this.settings.incognito)
		await this.requestInterceptor.attach(this.client.page)

		this.testCancel = async () => {
			await testObserver.after(this)
		}

		this.failed = false
		this.runningBrowser = null

		// await this.observer.attachToNetworkRecorder()

		debug('run() start')

		const { testData } = this.script

		try {
			const browser = new Browser<Step>(
				this.script.runEnv.workRoot,
				this.client,
				this.settings,
				this.willRunCommand.bind(this, testObserver),
				this.didRunCommand.bind(this, testObserver),
			)

			this.runningBrowser = browser

			if (this.settings.clearCache) await browser.clearBrowserCache()
			if (this.settings.clearCookies) await browser.clearBrowserCookies()
			if (this.settings.device) await browser.emulateDevice(this.settings.device)
			if (this.settings.userAgent) await browser.setUserAgent(this.settings.userAgent)
			if (this.settings.disableCache) await browser.setCacheDisabled(true)
			if (this.settings.extraHTTPHeaders)
				await browser.setExtraHTTPHeaders(this.settings.extraHTTPHeaders)

			debug('running this.before(browser)')
			await testObserver.before(this)

			debug('Feeding data')
			const testDataRecord = testData.feed()
			if (testDataRecord === null) {
				throw new Error('Test data exhausted, consider making it circular?')
			} else {
				debug(JSON.stringify(testDataRecord))
			}

			debug('running steps')
			for (const step of this.steps) {
				const stepType = step.type
				if (stepType === StepType.ONCE && iteration > 1) {
					continue
				}

				browser.customContext = step

				await Promise.race([
					this.runStep(testObserver, browser, step, testDataRecord),
					cancelToken.promise,
				])

				if (cancelToken.isCancellationRequested) return

				if (this.failed) {
					console.log('failed, bailing out of steps')
					throw Error('test failed')
				}
			}
		} catch (err) {
			console.log('error -> failed', err)
			this.failed = true
			throw err
		} finally {
			await this.requestInterceptor.detach(this.client.page)
		}

		// TODO report skipped steps
		await testObserver.after(this)
	}

	get currentURL(): string {
		if (this.runningBrowser == null) {
			return ''
		} else {
			return this.runningBrowser.url
		}
	}

	async runStep(
		testObserver: TestObserver,
		browser: Browser<Step>,
		step: Step,
		testDataRecord: any,
	) {
		let error: Error | null = null
		await testObserver.beforeStep(this, step)

		const originalBrowserSettings = { ...browser.settings }

		try {
			debug(`Run step: ${step.name}`) // ${step.fn.toString()}`)

			browser.settings = { ...this.settings, ...step.stepOptions }
			await step.fn.call(null, browser, testDataRecord)
		} catch (err) {
			error = err
		} finally {
			browser.settings = originalBrowserSettings
		}

		if (error !== null) {
			debug('step error')
			console.log('step error -> failed')
			this.failed = true

			await testObserver.onStepError(this, step, this.liftToStructuredError(error))
		} else {
			await testObserver.onStepPassed(this, step)
		}

		await testObserver.afterStep(this, step)

		if (error === null) {
			await this.doStepDelay()
		}

		// await this.syncNetworkRecorder()
		// this.networkRecorder.reset()
		debug('step done')
	}

	liftToStructuredError(error: Error): StructuredError<AnyErrorData> {
		if (error.name.startsWith('AssertionError')) {
			return new StructuredError<AssertionErrorData>(
				error.message,
				{ _kind: 'assertion' },
				error,
			).copyStackFromOriginalError()
		} else if ((error as StructuredError<AnyErrorData>)._structured === 'yes') {
			return error as StructuredError<AnyErrorData>
		} else {
			// catchall - this should trigger a documentation request further up the chain
			return StructuredError.wrapBareError<EmptyErrorData>(error, { _kind: 'empty' }, 'test')
		}
	}

	public get stepNames(): string[] {
		return this.steps.map(s => s.name)
	}

	public async doStepDelay() {
		if (this.skipping || this.settings.stepDelay <= 0) {
			return
		}

		await new Promise(resolve => {
			if (!this.settings.stepDelay) {
				resolve()
				return
			}
			setTimeout(resolve, this.settings.stepDelay * 1e3 || DEFAULT_STEP_WAIT_SECONDS * 1e3)
		})
	}

	public async willRunCommand(testObserver: TestObserver, browser: Browser<Step>, command: string) {
		const step: Step = browser.customContext
		await testObserver.beforeStepAction(this, step, command)

		debug(`Before action: '${command}()' waiting on actionDelay: ${this.settings.actionDelay}`)
	}

	async didRunCommand(testObserver: TestObserver, browser: Browser<Step>, command: string) {
		await testObserver.afterStepAction(this, browser.customContext, command)
	}

	public async takeScreenshot(options?: ScreenshotOptions) {
		if (this.runningBrowser === null) return
		await this.runningBrowser.takeScreenshot(options)
	}

	public async fetchScreenshots(): Promise<string[]> {
		if (this.runningBrowser === null) return []
		return this.runningBrowser.fetchScreenshots()
	}

	/* @deprecated */
	newTrace(step: Step): ObjectTrace {
		return new ObjectTrace(this.script.runEnv.workRoot, step.name)
	}
}
