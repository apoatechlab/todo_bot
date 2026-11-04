package family.wall;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * Night and morning for the wall. The page goes black 23:00–06:30; the app
 * lets the screen sleep then, and this alarm lights it again at 06:30. Also
 * starts the wall after a reboot or an update.
 */
public class Wake extends BroadcastReceiver {
    static final LocalTime NIGHT_FROM = LocalTime.of(23, 0), NIGHT_TO = LocalTime.of(6, 30);
    static final String MORNING = "family.wall.MORNING";

    static boolean isNight() {
        LocalTime now = LocalTime.now();
        return !now.isBefore(NIGHT_FROM) || now.isBefore(NIGHT_TO);
    }

    /** The next 06:30, in the tablet's own zone. */
    static long nextMorning() {
        ZonedDateTime now = ZonedDateTime.now(ZoneId.systemDefault());
        ZonedDateTime t = ZonedDateTime.of(LocalDate.now(), NIGHT_TO, ZoneId.systemDefault());
        if (!t.isAfter(now)) t = t.plusDays(1);
        return t.toInstant().toEpochMilli();
    }

    static void schedule(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = PendingIntent.getBroadcast(c, 0,
                new Intent(c, Wake.class).setAction(MORNING),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        long at = nextMorning();
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);   // within minutes is fine too
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (a == null) return;
        if (!a.equals(MORNING) && !a.equals(Intent.ACTION_BOOT_COMPLETED)
                && !a.equals(Intent.ACTION_MY_PACKAGE_REPLACED)) return;
        // A phone that only uses the screen saver or the wallpaper is left alone.
        if (!Wall.wallMode(c) || Wall.url(c).isEmpty()) return;
        schedule(c);

        if (a.equals(MORNING)) {
            PowerManager pm = c.getSystemService(PowerManager.class);
            if (pm != null) {
                pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE, "wall:morning").acquire(10_000);
            }
        }
        // Coming to the front from the background needs "display over other
        // apps"; without it the screen still lights, showing whatever was last.
        if (Build.VERSION.SDK_INT < 29 || Settings.canDrawOverlays(c)) {
            c.startActivity(new Intent(c, WallActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
        }
    }
}
