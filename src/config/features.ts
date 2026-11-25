/**
 * Feature switches of the SDK. PY: FEATURES (`up_down`).
 *
 * `upDown`: Up/Down is not enabled yet. While it is false, every `client.updown` call throws `NotDeployedError`
 * ("Up/Down is not enabled yet.") before any network call, and `client.getClaimables()` leaves its Up/Down section
 * empty.
 */
export const FEATURES: { upDown: boolean } = { upDown: false };
