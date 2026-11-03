package family.wall;

import android.content.Context;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** The saved wall link, and a WebView set up to show it. */
final class Wall {
    private static final String PREFS = "wall", URL = "url";

    static String url(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(URL, "");
    }

    static void save(Context c, String url) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(URL, url.trim()).apply();
    }

    static WebView view(Context c) {
        WebView w = new WebView(c);
        w.setBackgroundColor(0xff0b0c0e); // the page's own black, so loading never flashes white
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);     // the page keeps its key in localStorage
        return w;
    }

    private Wall() {}
}
