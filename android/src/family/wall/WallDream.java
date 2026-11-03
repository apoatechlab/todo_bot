package family.wall;

import android.service.dreams.DreamService;
import android.webkit.WebView;

/**
 * Android's screen saver ("dream") showing the wall page. Not interactive: the
 * first touch wakes the phone, as any screen saver should.
 */
public class WallDream extends DreamService {
    private WebView web;

    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(false);
        setFullscreen(true);
        setScreenBright(true);
        web = Wall.view(this);
        setContentView(web);
    }

    @Override
    public void onDreamingStarted() {
        super.onDreamingStarted();
        String url = Wall.url(this);
        web.loadUrl(url.isEmpty() ? "about:blank" : url);
    }

    @Override
    public void onDetachedFromWindow() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDetachedFromWindow();
    }
}
