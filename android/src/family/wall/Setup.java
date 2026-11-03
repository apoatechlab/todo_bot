package family.wall;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Paste the wall link once; then pick «Сегодня» as the screen saver. The link
 * can also arrive from adb: am start -n family.wall/.Setup --es url '<link>'
 */
public class Setup extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String fromAdb = getIntent().getStringExtra("url");
        if (fromAdb != null && !fromAdb.isEmpty()) {
            Wall.save(this, fromAdb);
            Toast.makeText(this, "Ссылка сохранена", Toast.LENGTH_SHORT).show();
        }

        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        TextView hint = new TextView(this);
        hint.setText("Ссылка на страницу /wall (с ?k=…). Потом выберите «Сегодня» в настройках заставки — она включается, когда телефон заряжается.");
        root.addView(hint);

        final EditText url = new EditText(this);
        url.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        url.setSingleLine(true);
        url.setText(Wall.url(this));
        root.addView(url);

        Button save = new Button(this);
        save.setText("Сохранить");
        save.setOnClickListener(v -> {
            Wall.save(this, url.getText().toString());
            Toast.makeText(this, "Сохранено", Toast.LENGTH_SHORT).show();
        });
        root.addView(save);

        Button dream = new Button(this);
        dream.setText("Настройки заставки");
        dream.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_DREAM_SETTINGS)));
        root.addView(dream);

        setContentView(root);
    }
}
