package android.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

public class Activity extends Context {
    public static final int RESULT_OK = -1;
    public static final int RESULT_CANCELED = 0;
    public static final int DEFAULT_KEYS_DISABLE = 0;

    public void onCreate(Bundle savedInstanceState) {}
    public void onStart() {}
    public void onResume() {}
    public void onPause() {}
    public void onStop() {}
    public void onDestroy() {}
    public void onRestart() {}
    public void finish() {}
    public boolean isFinishing() { return false; }
    public void setContentView(int layoutResID) {}
    public void runOnUiThread(Runnable action) { action.run(); }
    public Intent getIntent() { return new Intent(); }
    public void startActivity(Intent intent) {}
    public void setResult(int resultCode) {}
    public void setResult(int resultCode, Intent data) {}
    public int getTaskId() { return 0; }
    public Object getSystemService(String name) { return null; }
    public void overridePendingTransition(int enterAnim, int exitAnim) {}
}