/**
 * The prompt's clock line: offset and DST changes spelled out, so the model
 * stops assuming summer time after the clocks go back.
 */
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();
const tz = 'Europe/Madrid';

const winter = W.clockLine(tz, new Date('2026-11-02T20:51:00Z'));
ok('winter: local wall clock', winter.includes('Monday, 2 November 2026') && winter.includes('21:51'), winter);
ok('winter: offset +01:00', winter.includes('UTC+01:00.'), winter);
ok('winter: last change 25 Oct', winter.includes('last changed on 2026-10-25'), winter);
ok('winter: next change 28 Mar to +02:00', winter.includes('2027-03-28, to UTC+02:00'), winter);

const summer = W.clockLine(tz, new Date('2026-07-01T10:00:00Z'));
ok('summer: 12:00 at +02:00', summer.includes('12:00') && summer.includes('UTC+02:00.'), summer);
ok('summer: next change to +01:00', summer.includes('2026-10-25, to UTC+01:00'), summer);

const utc = W.clockLine('UTC', new Date('2026-11-02T20:51:00Z'));
ok('no DST zone: no change lines', !utc.includes('changed') && !utc.includes('Next change'), utc);

done();
