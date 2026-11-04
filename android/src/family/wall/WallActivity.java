package family.wall;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebView;

/**
 * The wall itself, for a tablet: the page full screen, the screen held on by
 * day. At night it lets go and the tablet sleeps on its own timeout; Wake turns
 * the screen back on in the morning and brings this to the front.
 */
public class WallActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            hold();
            main.postDelayed(this, 60_000);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String url = Wall.url(this);
        if (url.isEmpty()) {
            startActivity(new Intent(this, Setup.class));
            finish();
            return;
        }
        // Over a swipe-only lock screen, and able to light the screen when Wake
        // brings it up in the morning.
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km != null) km.requestDismissKeyguard(this, null);

        web = Wall.view(this);
        setContentView(web);
        web.loadUrl(url);
        Wall.setWallMode(this);
        Wake.schedule(this);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (web != null) web.onResume();
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        main.removeCallbacks(tick);
        main.post(tick);
    }

    @Override
    protected void onPause() {
        main.removeCallbacks(tick);
        super.onPause();
    }

    @Override
    protected void onStop() {
        if (web != null) web.onPause();      // screen off for the night: no work in the dark
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) immersive();
    }

    /** Keep the screen on by day; at night let the tablet's own timeout put it out. */
    private void hold() {
        if (Wake.isNight()) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @SuppressWarnings("deprecation")
    private void immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
