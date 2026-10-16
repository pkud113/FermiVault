// Reopens the last vault as soon as the app's code loads, while the UI is still mounting, so
// startup waits for the slower of the two rather than both in turn.
import { api } from "./api";
import { app } from "./store.svelte";

export const startup = api.lastVault().then((v) => (v ? app.openVault(v) : undefined));
