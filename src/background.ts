import { checkForUpdate, showBadge } from './update_check';

// Looks for a newer GitHub release twice a day and flags it on the toolbar icon.
// Firefox builds signed by the release workflow also update themselves through gecko.update_url.
const ALARM = 'astral-comet-update-check';

const run = (force = false) => void checkForUpdate({ force }).then(showBadge);

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 12 * 60, delayInMinutes: 1 });
  run(true);
});
chrome.runtime.onStartup.addListener(() => run());
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) run(true); });
