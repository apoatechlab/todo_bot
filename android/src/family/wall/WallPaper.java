package family.wall;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.service.wallpaper.WallpaperService;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.view.SurfaceHolder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Live wallpaper with today's tasks, for the lock screen. Unlike the screen
 * saver it runs on battery, so it keeps no connection open: it fetches when it
 * becomes visible (the screen lights up) and every few minutes while it stays
 * visible, and draws the last good answer meanwhile.
 */
public class WallPaper extends WallpaperService {
    private static final long TICK = 60_000, STALE = 5 * 60_000, MIN_GAP = 20_000;

    // The wall page's palette.
    private static final int BG_TOP = 0xff0b0c0e, BG_BOTTOM = 0xff15171b, INK = 0xffece6da,
            MUTED = 0xff8b8579, ACCENT = 0xffe9b872, LATE = 0xffe7836b;

    @Override
    public Engine onCreateEngine() {
        return new Paper();
    }

    private class Paper extends Engine {
        private final Handler main = new Handler(Looper.getMainLooper());
        private final ExecutorService io = Executors.newSingleThreadExecutor();
        private JSONObject data;
        private long fetchedAt, triedAt;
        private boolean visible;

        private final Runnable tick = new Runnable() {
            @Override public void run() {
                if (!visible) return;
                if (System.currentTimeMillis() - fetchedAt > STALE) fetch();
                draw();                                  // past tasks dim as the day goes
                main.postDelayed(this, TICK);
            }
        };

        @Override
        public void onCreate(SurfaceHolder holder) {
            super.onCreate(holder);
            String cached = prefs().getString("last", null);
            try { if (cached != null) data = new JSONObject(cached); } catch (Exception ignored) {}
        }

        @Override
        public void onVisibilityChanged(boolean v) {
            visible = v;
            main.removeCallbacks(tick);
            if (v) {
                draw();
                fetch();
                main.postDelayed(tick, TICK);
            }
        }

        @Override
        public void onSurfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            super.onSurfaceChanged(holder, format, width, height);
            draw();
        }

        @Override
        public void onDestroy() {
            main.removeCallbacksAndMessages(null);
            io.shutdownNow();
            super.onDestroy();
        }

        private SharedPreferences prefs() {
            return getSharedPreferences("wall", Context.MODE_PRIVATE);
        }

        private void fetch() {
            long now = System.currentTimeMillis();
            if (now - triedAt < MIN_GAP) return;         // screen on/off/on shouldn't hammer the worker
            triedAt = now;
            final String api = Wall.api(WallPaper.this);
            if (api == null) return;
            io.execute(() -> {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(api).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(10000);
                    c.setUseCaches(false);
                    if (c.getResponseCode() != 200) return;
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    try (InputStream in = c.getInputStream()) {
                        byte[] b = new byte[8192];
                        for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
                    }
                    String body = buf.toString("UTF-8");
                    JSONObject j = new JSONObject(body);
                    prefs().edit().putString("last", body).apply();
                    main.post(() -> {
                        data = j;
                        fetchedAt = System.currentTimeMillis();
                        draw();
                    });
                } catch (Exception ignored) {
                    // Offline: keep showing the last good answer.
                }
            });
        }

        private void draw() {
            SurfaceHolder sh = getSurfaceHolder();
            Canvas c = null;
            try {
                c = sh.lockCanvas();
                if (c != null) paint(c);
            } catch (Exception ignored) {
            } finally {
                if (c != null) sh.unlockCanvasAndPost(c);
            }
        }

        // ------------------------------------------------------------ drawing

        private float dp;

        private TextPaint text(float sp, int color, Typeface face) {
            TextPaint p = new TextPaint(Paint.ANTI_ALIAS_FLAG);
            p.setTextSize(sp * dp);
            p.setColor(color);
            p.setTypeface(face);
            return p;
        }

        private StaticLayout layout(CharSequence s, TextPaint p, int width, int maxLines) {
            return StaticLayout.Builder.obtain(s, 0, s.length(), p, Math.max(1, width))
                    .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                    .setLineSpacing(0, 1.08f)
                    .setIncludePad(false)
                    .setMaxLines(maxLines)
                    .setEllipsize(TextUtils.TruncateAt.END)
                    .build();
        }

        /** One drawn piece of the block: a layout at an x offset, with space above it. */
        private final class Piece {
            final StaticLayout l; final float x, gap; final int alpha;
            Piece(StaticLayout l, float x, float gap, int alpha) { this.l = l; this.x = x; this.gap = gap; this.alpha = alpha; }
        }

        private void paint(Canvas c) {
            int w = c.getWidth(), h = c.getHeight();
            dp = getResources().getDisplayMetrics().density;

            Paint bg = new Paint();
            bg.setShader(new LinearGradient(0, 0, 0, h, BG_TOP, BG_BOTTOM, Shader.TileMode.CLAMP));
            c.drawRect(0, 0, w, h, bg);

            float side = 28 * dp;
            int width = (int) (w - 2 * side);
            Typeface regular = Typeface.create("sans-serif", Typeface.NORMAL);
            Typeface medium = Typeface.create("sans-serif-medium", Typeface.NORMAL);

            // The system's clock sits on top and its fingerprint/shortcuts at
            // the bottom; the free band between is ours. Grow upwards from its
            // lower edge so a short list sits near the thumb, not under the clock.
            float bottom = h * 0.70f, top = h * 0.34f;

            if (Wall.api(WallPaper.this) == null) {
                StaticLayout l = layout("Откройте приложение «Сегодня» и вставьте ссылку на /wall",
                        text(16, MUTED, regular), width, 4);
                c.save(); c.translate(side, bottom - l.getHeight()); l.draw(c); c.restore();
                return;
            }
            if (data == null) return;

            String tz = data.optString("tz", "Europe/Madrid");
            ZonedDateTime now = ZonedDateTime.now(ZoneId.of(tz));
            String hhmm = String.format("%02d:%02d", now.getHour(), now.getMinute());
            String todayLocal = now.toLocalDate().toString();
            boolean stale = !todayLocal.equals(data.optString("today"));   // yesterday's answer, offline overnight

            JSONArray tasks = stale ? new JSONArray() : data.optJSONArray("tasks");
            if (tasks == null) tasks = new JSONArray();

            TextPaint head = text(12, MUTED, medium);
            head.setLetterSpacing(0.16f);
            TextPaint item = text(21, INK, regular);
            TextPaint time = text(21, ACCENT, regular);
            TextPaint small = text(14, MUTED, regular);

            boolean anyTime = false;
            for (int i = 0; i < tasks.length(); i++) if (!tasks.optJSONObject(i).isNull("time")) anyTime = true;
            float timeW = anyTime ? time.measureText("00:00") + 14 * dp : 0;

            // Head: «СЕГОДНЯ  3» and the day's mark as a pill.
            List<Piece> before = new ArrayList<>(), list = new ArrayList<>(), after = new ArrayList<>();
            String headText = stale ? "НЕТ СВЯЗИ" : "СЕГОДНЯ" + (tasks.length() > 0 ? "   " + tasks.length() : "");
            before.add(new Piece(layout(headText, head, width, 1), 0, 0, 255));

            for (int i = 0; i < tasks.length(); i++) {
                JSONObject t = tasks.optJSONObject(i);
                String tm = t.isNull("time") ? null : t.optString("time");
                boolean past = tm != null && tm.compareTo(hhmm) < 0;
                String who = t.isNull("who") ? null : t.optString("who");
                String content = t.optString("content") + (who != null ? "  · " + who : "");
                StaticLayout l = layout(content, item, (int) (width - timeW), 2);
                list.add(new Piece(l, timeW, 12 * dp, past ? 105 : 255));
                if (tm != null) list.add(new Piece(layout(tm, time, (int) timeW, 1), -1, 0, past ? 105 : 255));
            }
            if (tasks.length() == 0 && !stale) {
                list.add(new Piece(layout("Ничего не запланировано", text(21, MUTED, regular), width, 1), 0, 12 * dp, 255));
            }

            JSONArray overdue = stale ? null : data.optJSONArray("overdue");
            if (overdue != null && overdue.length() > 0) {
                StringBuilder s = new StringBuilder("Просрочено: ");
                for (int i = 0; i < overdue.length(); i++) {
                    if (i > 0) s.append(" · ");
                    s.append(overdue.optJSONObject(i).optString("content"));
                }
                after.add(new Piece(layout(s, text(14, LATE, regular), width, 2), 0, 22 * dp, 255));
            }
            JSONArray tomorrow = stale ? null : data.optJSONArray("tomorrow");
            JSONObject tmMark = stale ? null : data.optJSONObject("tomorrowMark");
            if ((tomorrow != null && tomorrow.length() > 0) || tmMark != null) {
                StringBuilder s = new StringBuilder("ЗАВТРА   ");
                if (tmMark != null) s.append(tmMark.optString("label")).append(tomorrow != null && tomorrow.length() > 0 ? " · " : "");
                for (int i = 0; tomorrow != null && i < tomorrow.length(); i++) {
                    JSONObject t = tomorrow.optJSONObject(i);
                    if (i > 0) s.append(" · ");
                    if (!t.isNull("time")) s.append(t.optString("time")).append(' ');
                    s.append(t.optString("content"));
                }
                after.add(new Piece(layout(s, small, width, 2), 0, 22 * dp, 255));
            }

            // Fit: drop tasks from the end (past ones first) until the block
            // fits the band, and say how many went.
            int dropped = 0;
            while (height(before) + height(list) + height(after) > bottom - top && countItems(list) > 0) {
                removeOne(list, hhmm);
                dropped++;
            }
            if (dropped > 0) {
                list.add(new Piece(layout("и ещё " + dropped, small, width, 1), timeW, 10 * dp, 255));
            }

            List<Piece> all = new ArrayList<>(before);
            all.addAll(list);
            all.addAll(after);
            float y = bottom - height(all);
            float lastY = y;
            for (Piece p : all) {
                if (p.x >= 0) { y += p.gap; lastY = y; }
                float py = p.x >= 0 ? y : lastY;         // a time sits on its task's first line
                float px = p.x >= 0 ? side + p.x : side;
                c.save();
                c.translate(px, py);
                p.l.getPaint().setAlpha(p.alpha);
                p.l.draw(c);
                c.restore();
                if (p.x >= 0) y += p.l.getHeight();
            }

            // The mark pill, right of the head.
            JSONObject mark = stale ? null : data.optJSONObject("mark");
            if (mark != null) {
                TextPaint mp = text(12, BG_TOP, medium);
                String label = mark.optString("label");
                float tw = mp.measureText(label), padX = 9 * dp, padY = 4 * dp;
                float cy = bottom - height(all) + all.get(0).l.getHeight() / 2f;
                float hx = side + head.measureText(headText) + 14 * dp;
                Paint pill = new Paint(Paint.ANTI_ALIAS_FLAG);
                pill.setColor(parseColor(mark.optString("color"), ACCENT));
                float ph = mp.getTextSize() + 2 * padY;
                RectF r = new RectF(hx, cy - ph / 2, hx + tw + 2 * padX, cy + ph / 2);
                c.drawRoundRect(r, ph / 2, ph / 2, pill);
                c.drawText(label, hx + padX, cy - (mp.ascent() + mp.descent()) / 2, mp);
            }
        }

        private float height(List<Piece> ps) {
            float sum = 0;
            for (Piece p : ps) if (p.x >= 0) sum += p.gap + p.l.getHeight();
            return sum;
        }

        private int countItems(List<Piece> ps) {
            int n = 0;
            for (Piece p : ps) if (p.x >= 0) n++;
            return n;
        }

        /** Remove one task (with its time): the earliest past one, else the last. */
        private void removeOne(List<Piece> ps, String hhmm) {
            int at = -1;
            for (int i = 0; i < ps.size(); i++) {
                Piece p = ps.get(i);
                if (p.x >= 0 && p.alpha < 255) { at = i; break; }
            }
            if (at < 0) for (int i = ps.size() - 1; i >= 0; i--) if (ps.get(i).x >= 0) { at = i; break; }
            if (at < 0) return;
            ps.remove(at);
            if (at < ps.size() && ps.get(at).x < 0) ps.remove(at);
        }

        private int parseColor(String s, int fallback) {
            try { return android.graphics.Color.parseColor(s); } catch (Exception e) { return fallback; }
        }
    }
}
