package com.inhouse.learn;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps an answer alive while the user is in another app (APK 1.0.6).
 *
 * Android freezes a background app within seconds, and the page's stream to
 * OpenRouter dies with "network error". While the page says it is working
 * ({type: 'working', on: true}), this foreground service shows an ongoing
 * "Inhouse Learn está respondiendo…" notification, which keeps the process
 * (and its WebView renderer) running. When the answer ends with the app out of
 * sight, {@link #answered} posts "Respuesta lista" with the start of the text;
 * tapping it opens that chat. Nothing runs on a server: the page itself goes on
 * answering on the phone.
 */
public class AnswerService extends Service {
    static final String CHANNEL_WORKING = "working";
    static final String CHANNEL_ANSWERS = "answers";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_CHAT = "chat";
    static final int ID_WORKING = 41;
    static final int ID_ANSWER = 42;
    // A turn never needs this long; a page that forgot to say «done» does not keep it on forever.
    static final long SAFETY_STOP_MS = 30 * 60 * 1000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable safetyStop = this::stopSelf;

    static void start(Context context, String title, String chat) {
        Intent intent = new Intent(context, AnswerService.class).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_CHAT, chat);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException error) {
            // Android refuses a foreground service started from the background
            // (ForegroundServiceStartNotAllowedException): the answer goes on as before.
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, AnswerService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels(this);
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String chat = intent != null ? intent.getStringExtra(EXTRA_CHAT) : null;
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_WORKING)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.answer_working))
                .setContentText(title == null || title.isEmpty() ? getString(R.string.answer_working_text) : title)
                .setContentIntent(openApp(this, chat, 0))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setProgress(0, 0, true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(ID_WORKING, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(ID_WORKING, notification);
            }
        } catch (RuntimeException error) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(safetyStop);
        handler.postDelayed(safetyStop, SAFETY_STOP_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15 limits dataSync services; stop cleanly when it says so.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(safetyStop);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** "Respuesta lista": the answer finished while the app was out of sight. */
    @SuppressLint("MissingPermission") // areNotificationsEnabled() is checked first; SecurityException caught.
    static void answered(Context context, String title, String text, String chat) {
        createChannels(context);
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        String body = text == null ? "" : text.trim();
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ANSWERS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title == null || title.isEmpty() ? context.getString(R.string.answer_ready) : title)
                .setContentText(body.isEmpty() ? context.getString(R.string.answer_ready_text) : body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body.isEmpty() ? context.getString(R.string.answer_ready_text) : body))
                .setContentIntent(openApp(context, chat, 1))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build();
        try {
            manager.notify(ID_ANSWER, notification);
        } catch (SecurityException error) {
            // Notifications not allowed: nothing to show.
        }
    }

    static void clearAnswered(Context context) {
        NotificationManagerCompat.from(context).cancel(ID_ANSWER);
    }

    static PendingIntent openApp(Context context, String chat, int request) {
        Intent intent = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (chat != null && !chat.isEmpty()) intent.putExtra(EXTRA_CHAT, chat);
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel working = new NotificationChannel(CHANNEL_WORKING, context.getString(R.string.channel_working), NotificationManager.IMPORTANCE_LOW);
        working.setDescription(context.getString(R.string.channel_working_description));
        working.setShowBadge(false);
        NotificationChannel answers = new NotificationChannel(CHANNEL_ANSWERS, context.getString(R.string.channel_answers), NotificationManager.IMPORTANCE_DEFAULT);
        answers.setDescription(context.getString(R.string.channel_answers_description));
        manager.createNotificationChannel(working);
        manager.createNotificationChannel(answers);
    }
}
