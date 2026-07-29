package io.ethan.webadb.attestation;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.UriMatcher;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.util.Log;

/**
 * ContentProvider-based probe entry point. Unlike an Activity launch,
 * querying a ContentProvider from `adb shell content query` is guaranteed
 * to instantiate the app process — Android's package manager is required
 * to instantiate every provider declared in the manifest before any
 * client (including adb) can bind to it.
 *
 * Usage:
 *   adb shell content query --uri content://io.ethan.webadb.attestation.provider/probe
 *
 * The provider's call() method runs the probe synchronously, so the
 * output file at /data/local/tmp/webadb_attestation.json is guaranteed
 * to appear before the shell command returns.
 */
public class BootProvider extends ContentProvider {
    private static final String TAG = "WebAdbBoot";

    private static final String AUTHORITY = "io.ethan.webadb.attestation.provider";
    public static final Uri CONTENT_URI = Uri.parse("content://" + AUTHORITY + "/probe");

    private static final int PROBE = 1;
    private UriMatcher matcher;

    @Override
    public boolean onCreate() {
        Log.i(TAG, "BootProvider.onCreate");
        matcher = new UriMatcher(UriMatcher.NO_MATCH);
        matcher.addURI(AUTHORITY, "probe", PROBE);
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        Log.i(TAG, "BootProvider.query: " + uri);
        if (matcher.match(uri) == PROBE) {
            Probe.run(getContext());
        }
        // Return an empty cursor so `content query` succeeds.
        return new MatrixCursor(new String[]{"result"});
    }

    @Override
    public String getType(Uri uri) { return "vnd.android.cursor.item/probe"; }

    @Override
    public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override
    public int update(Uri uri, ContentValues values, String selection,
                      String[] selectionArgs) { return 0; }
}
