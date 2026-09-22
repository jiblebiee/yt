package vn.jukebox.remote;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Vỏ WebView cho trang /remote của Jukebox.
 *
 * Máy chủ chạy HTTP thường trong LAN nên app bật usesCleartextTraffic
 * (xem network_security_config.xml). Không có gì được tải từ Internet:
 * toàn bộ giao diện đến từ Raspberry Pi trong nhà.
 */
public class MainActivity extends AppCompatActivity {

  private static final String PREFS = "jukebox";
  private static final String KEY_SERVER = "server";

  private WebView web;
  private boolean lastLoadFailed = false;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    FrameLayout root = new FrameLayout(this);
    root.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    web = new WebView(this);
    root.addView(web, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(root);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setSupportZoom(false);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
        // Giữ mọi điều hướng trong app; trang remote không mở link ngoài.
        return false;
      }

      @Override
      public void onPageStarted(WebView v, String url, android.graphics.Bitmap fav) {
        lastLoadFailed = false;
      }

      @Override
      public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
        if (req == null || !req.isForMainFrame()) return;
        lastLoadFailed = true;
        showConnectionError();
      }
    });

    String server = serverUrl();
    if (server == null) {
      askServer(true);
    } else {
      web.loadUrl(server + "/remote");
    }
  }

  private SharedPreferences prefs() {
    return getSharedPreferences(PREFS, MODE_PRIVATE);
  }

  /** Địa chỉ đã lưu, hoặc null nếu người dùng chưa nhập lần nào. */
  private String serverUrl() {
    return prefs().getString(KEY_SERVER, null);
  }

  /** Bỏ dấu / thừa và tự thêm http:// nếu người dùng chỉ gõ tên máy. */
  private static String normalize(String raw) {
    String u = raw == null ? "" : raw.trim();
    while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
    if (u.isEmpty()) return null;
    if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
    return u;
  }

  private void askServer(final boolean firstRun) {
    final EditText input = new EditText(this);
    input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    input.setHint(R.string.server_hint);
    String current = serverUrl();
    input.setText(current != null ? current : getString(R.string.default_server));
    input.setSelectAllOnFocus(true);

    AlertDialog.Builder b = new AlertDialog.Builder(this)
        .setTitle(R.string.server_title)
        .setView(input)
        .setCancelable(!firstRun)
        .setPositiveButton(R.string.save, (d, w) -> {
          String u = normalize(input.getText().toString());
          if (u == null) { askServer(firstRun); return; }
          prefs().edit().putString(KEY_SERVER, u).apply();
          web.loadUrl(u + "/remote");
        });
    if (!firstRun) b.setNegativeButton(R.string.cancel, null);
    b.show();
  }

  private void showConnectionError() {
    new AlertDialog.Builder(this)
        .setMessage(R.string.load_failed)
        .setPositiveButton(R.string.retry, (d, w) -> {
          String u = serverUrl();
          if (u != null) web.loadUrl(u + "/remote");
        })
        .setNegativeButton(R.string.change_server, (d, w) -> askServer(false))
        .show();
  }

  @Override
  public void onBackPressed() {
    if (!lastLoadFailed && web.canGoBack()) {
      web.goBack();
      return;
    }
    // Ở màn hình gốc: hỏi thoát, đồng thời là chỗ để đổi địa chỉ máy chủ.
    new AlertDialog.Builder(this)
        .setTitle(R.string.app_name)
        .setNegativeButton(R.string.change_server, (d, w) -> askServer(false))
        .setPositiveButton("Thoát", (d, w) -> finish())
        .setNeutralButton(R.string.cancel, null)
        .show();
  }
}
