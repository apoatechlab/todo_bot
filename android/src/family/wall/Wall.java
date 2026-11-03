package family.wall;

import android.content.Context;
import android.net.Uri;
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

    /** The JSON behind the wall page: same host, same key. */
    static String api(Context c) {
        Uri u = Uri.parse(url(c));
        String k = u.getQueryParameter("k");
        if (u.getScheme() == null || u.getEncodedAuthority() == null || k == null || k.isEmpty()) return null;
        return u.getScheme() + "://" + u.getEncodedAuthority() + "/api/wall?k=" + Uri.encode(k);
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
