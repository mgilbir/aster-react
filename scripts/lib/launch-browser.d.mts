export function launchBrowser<B, O = undefined>(browserType: { launch(options?: O): Promise<B> }, options?: O): Promise<B>
