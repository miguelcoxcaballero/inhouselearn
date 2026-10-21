package com.inhouse.learn;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.inhouse.services.updater.NativeUpdates;
import com.inhouse.services.updater.UpdateActivity;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Collections;

/**
 * Inhouse Learn for Android: a full-screen WebView around the hosted web app
 * (https://miguelcoxcaballero.github.io/inhouselearn/), so every web release
 * reaches the app without a new APK. Read android/README.md first.
 *
 * The page talks to this shell only through {@code window.InhouseLearnApp},
 * an origin-restricted WebMessageListener (never addJavascriptInterface):
 * Google sign-in in a Chrome Custom Tab, the system "save as" dialog for
 * downloads, Android's back button asking the page first, and opening the
 * update settings.
 *
 * APK updates come from the shared Inhouse services updater (UPDATER.md):
 * NativeUpdates runs its hidden checker with the bundled assets and opens
 * UpdateActivity for the popup. The hosted page never gets an install bridge.
 * The updater code is synced from its canonical repository; never edit it here.
 */
public class MainActivity extends ComponentActivity {
    static final String APP_ORIGIN = "https://miguelcoxcaballero.github.io";
    static final String APP_PATH = "/inhouselearn/";
    static final String START_URL = APP_ORIGIN + APP_PATH + "?app=android";
    static final String APP_SCHEME = "inhouselearn";
    static final String GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/";
    static final long SPLASH_MAX_MS = 2500;

    private WebView webView;
    private boolean pageReady;
    private boolean offlineRetry;
    private long createdAt;
    private String pendingAuthQuery;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingSave;
    private String pendingSaveMime = "application/octet-stream";
    private NativeUpdates updates;

    private final ActivityResultLauncher<Intent> filePicker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), this::deliverPickedFiles);

    private final ActivityResultLauncher<String> saveDocument = registerForActivityResult(
            new ActivityResultContracts.CreateDocument("application/octet-stream") {
                @NonNull
                @Override
                public Intent createIntent(@NonNull Context context, @NonNull String input) {
                    return super.createIntent(context, input).setType(pendingSaveMime);
                }
            }, this::writePendingSave);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The bulb stays up until the page has painted (at most SPLASH_MAX_MS),
        // so the app opens straight onto the chat instead of a blank view.
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        createdAt = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() -> !pageReady && SystemClock.uptimeMillis() - createdAt < SPLASH_MAX_MS);

        int background = ContextCompat.getColor(this, R.color.app_background);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(background);
        webView = new WebView(this);
        webView.setBackgroundColor(background);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Edge to edge: dark icons on the web's light background, and the page
        // laid out between the system bars and above the keyboard, so the
        // message box is never hidden while typing.
        WindowInsetsControllerCompat systemBars = WindowCompat.getInsetsController(getWindow(), root);
        systemBars.setAppearanceLightStatusBars(true);
        systemBars.setAppearanceLightNavigationBars(true);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        configureWebView();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // The page closes its own sheets, menus and sidebar first.
                webView.evaluateJavascript(
                        "(typeof window.inhouseLearnBack === 'function' && window.inhouseLearnBack()) === true",
                        handled -> {
                            if ("true".equals(handled)) return;
                            if (webView.canGoBack()) {
                                webView.goBack();
                                return;
                            }
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        });
            }
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
        handleAppIntent(getIntent());
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        // Identify the shell without hiding that this is a WebView.
        settings.setUserAgentString(settings.getUserAgentString() + " InhouseLearnApp/" + BuildConfig.VERSION_NAME);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // The web has its own light design; never let Android invert it.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Only the app's own origin, main frame only, gets window.InhouseLearnApp.
            WebViewCompat.addWebMessageListener(webView, "InhouseLearnApp", Collections.singleton(APP_ORIGIN),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (isMainFrame && message.getData() != null) onWebMessage(message.getData());
                    });
        }
        webView.setWebViewClient(new ShellClient());
        webView.setWebChromeClient(new ShellChrome());
        webView.setDownloadListener((url, userAgent, disposition, mime, length) -> openExternal(Uri.parse(url)));
    }

    private void onWebMessage(String data) {
        try {
            JSONObject message = new JSONObject(data);
            switch (message.optString("type")) {
                case "signIn": {
                    String url = message.optString("url");
                    if (url.startsWith(GOOGLE_AUTH)) openCustomTab(Uri.parse(url));
                    break;
                }
                case "save": {
                    pendingSave = Base64.decode(message.optString("data"), Base64.DEFAULT);
                    String mime = message.optString("mime");
                    pendingSaveMime = mime.isEmpty() ? "application/octet-stream" : mime;
                    saveDocument.launch(message.optString("name", "inhouse-learn"));
                    break;
                }
                case "updates":
                    // Channel A/B and "Check for updates" (the profile menu in the app).
                    startActivity(new Intent(this, UpdateActivity.class).putExtra("settings", true));
                    break;
                case "open":
                    openExternal(Uri.parse(message.optString("url")));
                    break;
                case "haptic":
                    haptic(message.optString("style"));
                    break;
                default:
                    break;
            }
        } catch (JSONException | IllegalArgumentException error) {
            // Malformed messages are ignored; only the app's own page can send them.
        }
    }

    // --- Haptics -------------------------------------------------------------
    // The page asks for ChatGPT-like feedback (haptics.js). The system plays it
    // with its own haptic engine, so it follows the phone's haptics setting and
    // needs no VIBRATE permission. Streaming ticks come at most every 60 ms.

    private long lastTick;

    private void haptic(String style) {
        int sdk = Build.VERSION.SDK_INT;
        int constant;
        switch (style) {
            case "tick":
            case "drag": {
                long now = SystemClock.uptimeMillis();
                if (now - lastTick < 60) return;
                lastTick = now;
                constant = sdk >= 34 ? HapticFeedbackConstants.SEGMENT_FREQUENT_TICK
                        : sdk >= 27 ? HapticFeedbackConstants.TEXT_HANDLE_MOVE : HapticFeedbackConstants.CLOCK_TICK;
                break;
            }
            case "select":
                constant = sdk >= 34 ? HapticFeedbackConstants.SEGMENT_TICK : HapticFeedbackConstants.CLOCK_TICK;
                break;
            case "light":
                constant = sdk >= 27 ? HapticFeedbackConstants.KEYBOARD_RELEASE : HapticFeedbackConstants.VIRTUAL_KEY;
                break;
            case "send":
                constant = sdk >= 27 ? HapticFeedbackConstants.KEYBOARD_PRESS : HapticFeedbackConstants.VIRTUAL_KEY;
                break;
            case "success":
                constant = sdk >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK;
                break;
            case "error":
                constant = sdk >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
                break;
            default:
                return;
        }
        final int feedback = constant;
        webView.post(() -> webView.performHapticFeedback(feedback));
    }

    // --- Google sign-in -------------------------------------------------------
    // Google does not allow its sign-in page inside a WebView, so the page asks
    // for a Chrome Custom Tab. Google redirects to app-auth.html, which hands the
    // result back as inhouselearn://auth?...; the page checks its own state.

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAppIntent(intent);
    }

    private void handleAppIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data != null && APP_SCHEME.equals(data.getScheme())) handleAppUri(data);
    }

    private void handleAppUri(Uri uri) {
        if ("retry".equals(uri.getHost())) {
            offlineRetry = false;
            webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            webView.loadUrl(START_URL);
            return;
        }
        if (!"auth".equals(uri.getHost()) || uri.getEncodedQuery() == null) return;
        pendingAuthQuery = uri.getEncodedQuery();
        deliverPendingAuth();
    }

    private void deliverPendingAuth() {
        if (!pageReady || pendingAuthQuery == null) return;
        String query = pendingAuthQuery;
        pendingAuthQuery = null;
        webView.evaluateJavascript("window.inhouseLearnAuth && window.inhouseLearnAuth("
                + JSONObject.quote(query) + ")", null);
    }

    // --- Links, files and downloads ------------------------------------------

    private static boolean isAppUrl(Uri uri) {
        String path = uri.getPath() == null ? "" : uri.getPath();
        return "https".equals(uri.getScheme()) && "miguelcoxcaballero.github.io".equals(uri.getHost())
                && (path.startsWith(APP_PATH) || path.equals("/inhouselearn"));
    }

    private void openCustomTab(Uri uri) {
        int toolbar = ContextCompat.getColor(this, R.color.app_background);
        CustomTabsIntent tab = new CustomTabsIntent.Builder()
                .setDefaultColorSchemeParams(new CustomTabColorSchemeParams.Builder().setToolbarColor(toolbar).build())
                .setShowTitle(true)
                .build();
        try {
            tab.launchUrl(this, uri);
        } catch (ActivityNotFoundException error) {
            openWithSystem(uri);
        }
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if ("https".equals(scheme) || "http".equals(scheme)) openCustomTab(uri);
        else openWithSystem(uri);
    }

    private void openWithSystem(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show();
        }
    }

    private void deliverPickedFiles(ActivityResult result) {
        if (fileCallback == null) return;
        Uri[] picked = null;
        Intent data = result.getData();
        if (result.getResultCode() == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    private void writePendingSave(Uri target) {
        byte[] bytes = pendingSave;
        pendingSave = null;
        if (target == null || bytes == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IOException("No output stream");
            out.write(bytes);
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
        } catch (IOException | SecurityException error) {
            Toast.makeText(this, R.string.save_failed, Toast.LENGTH_SHORT).show();
        }
    }

    private void showOffline(WebView view) {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f0;"
                + "font-family:sans-serif;color:#1a1a1a;text-align:center;padding:24px'><div>"
                + "<p style='font-size:18px;font-weight:600'>Sin conexión</p>"
                + "<p style='color:#555'>inhouse learn necesita internet para cargar.</p>"
                + "<a href='inhouselearn://retry' style='display:inline-block;margin-top:12px;padding:12px 22px;"
                + "border-radius:999px;background:#1a1a1a;color:#fff;text-decoration:none'>Reintentar</a>"
                + "</div></body>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private final class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (APP_SCHEME.equals(uri.getScheme())) {
                handleAppUri(uri);
                return true;
            }
            if (isAppUrl(uri)) return false;
            // Everything outside the app opens in a Custom Tab or its own app.
            openExternal(uri);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            deliverPendingAuth();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            if (!offlineRetry) {
                // Offline: try the copy the WebView already has before giving up.
                offlineRetry = true;
                view.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
                view.loadUrl(START_URL);
                return;
            }
            pageReady = true;
            showOffline(view);
        }
    }

    private final class ShellChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                filePicker.launch(intent);
            } catch (ActivityNotFoundException error) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    // --- Lifecycle -------------------------------------------------------------

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        // Optional update prompts: B by default, Later snoozes them for 14 days.
        if (updates == null) updates = new NativeUpdates(getApplicationContext());
        updates.onResumed(this);
    }

    @Override
    protected void onPause() {
        if (updates != null) updates.onPaused(this);
        webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (updates != null) updates.onDestroyed(this);
        webView.destroy();
        super.onDestroy();
    }
}
