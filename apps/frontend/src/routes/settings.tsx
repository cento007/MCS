export { SettingsPage as Component } from '../features/settings/SettingsPage.js';

/**
 * `/settings/:category` (TDS 05 §2.2, §2.3).
 *
 * A thin lazy entry module, which is what makes Settings its own Rollup chunk. The screen
 * itself lives in `features/settings/` per the §2.1 slice layout.
 */
