const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const tauriRoot = path.join(appRoot, 'src-tauri');
const androidRoot = path.join(tauriRoot, 'gen', 'android');
const configPath = path.join(tauriRoot, 'tauri.conf.json');
const oldPackage = 'com.cameronamer.telegramdrive';

function fail(message) {
  console.error(`[prepare-android-runtime] ${message}`);
  process.exit(1);
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, content) {
  const old = fs.existsSync(file) ? readUtf8(file) : null;
  if (old !== content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[prepare-android-runtime] updated ${path.relative(appRoot, file)}`);
  }
}

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, predicate, out);
    else if (entry.isFile() && predicate(file)) out.push(file);
  }
  return out;
}

let config;
try {
  config = JSON.parse(readUtf8(configPath));
} catch (error) {
  fail(`unable to read tauri.conf.json: ${error.message}`);
}

const appId = config.identifier;
if (!appId || typeof appId !== 'string') {
  fail('tauri.conf.json has no identifier');
}
if (appId !== 'com.parallax.drive') {
  fail(`unexpected Android identifier: ${appId}`);
}

// Normalize stale package strings in Rust before Cargo compiles the Android library.
// This includes the JNI ClassLoader strings used for MainActivity and the upload service.
const rustFiles = walk(path.join(tauriRoot, 'src'), (file) => file.endsWith('.rs'));
for (const file of rustFiles) {
  const source = readUtf8(file);
  if (source.includes(oldPackage)) {
    writeIfChanged(file, source.split(oldPackage).join(appId));
  }
}

if (!fs.existsSync(androidRoot)) {
  fail('generated Android project is missing; run `npm run tauri android init -- --ci` first');
}

const mainCandidates = walk(
  path.join(androidRoot, 'app', 'src'),
  (file) => /MainActivity\.(kt|java)$/.test(file),
);
if (mainCandidates.length === 0) {
  fail('generated MainActivity source was not found');
}

const generatedMain = mainCandidates[0];
const kotlinDir = path.dirname(generatedMain);
const kotlinMain = path.join(kotlinDir, 'MainActivity.kt');
if (generatedMain.endsWith('.java') && generatedMain !== kotlinMain) {
  fs.rmSync(generatedMain, { force: true });
}

const mainActivitySource = `package ${appId}

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appContext = applicationContext
        currentActivity = this
        recordShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        appContext = applicationContext
        currentActivity = this
        recordShareIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        appContext = applicationContext
        currentActivity = this
    }

    override fun onDestroy() {
        if (currentActivity === this) {
            currentActivity = null
        }
        super.onDestroy()
    }

    private fun recordShareIntent(incoming: Intent?) {
        when (incoming?.action) {
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> pendingShareCount.incrementAndGet()
        }
    }

    companion object {
        private const val SUPPORTER_KEY_ALIAS = "parallax-supporter-secrets-v1"
        private const val SUPPORTER_PREFS = "parallax-supporter-secrets-v1"
        private const val SUPPORTER_PREFIX = "secret:"

        @Volatile
        private var currentActivity: MainActivity? = null

        @Volatile
        private var appContext: Context? = null

        private val pendingShareCount = AtomicInteger(0)

        @JvmStatic
        fun getAndClearShareCount(): Int = pendingShareCount.getAndSet(0)

        private fun supporterKey(): SecretKey {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = keyStore.getKey(SUPPORTER_KEY_ALIAS, null) as? SecretKey
            if (existing != null) return existing

            val generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore",
            )
            generator.init(
                KeyGenParameterSpec.Builder(
                    SUPPORTER_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            return generator.generateKey()
        }

        @JvmStatic
        fun getSupporterSecret(account: String): String? {
            val context = appContext ?: currentActivity?.applicationContext ?: return null
            return try {
                val encoded = context
                    .getSharedPreferences(SUPPORTER_PREFS, Context.MODE_PRIVATE)
                    .getString(SUPPORTER_PREFIX + account, null)
                    ?: return null
                val payload = Base64.decode(encoded, Base64.NO_WRAP)
                if (payload.size <= 12) return null

                val iv = payload.copyOfRange(0, 12)
                val ciphertext = payload.copyOfRange(12, payload.size)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    supporterKey(),
                    GCMParameterSpec(128, iv),
                )
                String(cipher.doFinal(ciphertext), Charsets.UTF_8)
            } catch (_: Throwable) {
                null
            }
        }

        @JvmStatic
        fun putSupporterSecret(account: String, secret: String): Boolean {
            val context = appContext ?: currentActivity?.applicationContext ?: return false
            return try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, supporterKey())
                val ciphertext = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
                val iv = cipher.iv
                val payload = ByteArray(iv.size + ciphertext.size)
                System.arraycopy(iv, 0, payload, 0, iv.size)
                System.arraycopy(ciphertext, 0, payload, iv.size, ciphertext.size)

                context
                    .getSharedPreferences(SUPPORTER_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(
                        SUPPORTER_PREFIX + account,
                        Base64.encodeToString(payload, Base64.NO_WRAP),
                    )
                    .commit()
            } catch (_: Throwable) {
                false
            }
        }

        @JvmStatic
        fun deleteSupporterSecret(account: String): Boolean {
            val context = appContext ?: currentActivity?.applicationContext ?: return false
            return try {
                context
                    .getSharedPreferences(SUPPORTER_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .remove(SUPPORTER_PREFIX + account)
                    .commit()
            } catch (_: Throwable) {
                false
            }
        }

        @JvmStatic
        fun openFileExternally(filePath: String, mimeType: String): Boolean {
            val activity = currentActivity ?: return false
            return try {
                val file = File(filePath)
                if (!file.isFile) return false

                val uri = FileProvider.getUriForFile(
                    activity,
                    BuildConfig.APPLICATION_ID + ".fileprovider",
                    file,
                )
                val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, mimeType.ifBlank { "application/octet-stream" })
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(Intent.createChooser(viewIntent, "Open with"))
                true
            } catch (_: Throwable) {
                false
            }
        }
    }
}
`;
writeIfChanged(kotlinMain, mainActivitySource);

const serviceFile = path.join(kotlinDir, 'UploadForegroundService.kt');
const serviceSource = `package ${appId}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

class UploadForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startSafelyInForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startSafelyInForeground()
        return START_NOT_STICKY
    }

    private fun startSafelyInForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = getSystemService(NotificationManager::class.java)
                if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                    manager.createNotificationChannel(
                        NotificationChannel(
                            CHANNEL_ID,
                            "Parallax Drive uploads",
                            NotificationManager.IMPORTANCE_LOW,
                        ),
                    )
                }
            }

            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            val pendingIntent = launchIntent?.let {
                PendingIntent.getActivity(
                    this,
                    0,
                    it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
            } else {
                Notification.Builder(this)
            }
                .setContentTitle("Parallax Drive")
                .setContentText("Upload is running")
                .setSmallIcon(applicationInfo.icon)
                .setOngoing(true)

            if (pendingIntent != null) builder.setContentIntent(pendingIntent)
            startForeground(NOTIFICATION_ID, builder.build())
        } catch (_: Throwable) {
            // Never let a notification/service restriction crash the app process.
            stopSelf()
        }
    }

    companion object {
        private const val CHANNEL_ID = "parallax_drive_uploads"
        private const val NOTIFICATION_ID = 14201

        @JvmStatic
        fun startService(context: Context) {
            try {
                val intent = Intent(context, UploadForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (_: Throwable) {
                // JNI caller treats this as best-effort; do not propagate platform exceptions.
            }
        }

        @JvmStatic
        fun stopService(context: Context) {
            try {
                context.stopService(Intent(context, UploadForegroundService::class.java))
            } catch (_: Throwable) {
                // Best-effort shutdown.
            }
        }
    }
}
`;
writeIfChanged(serviceFile, serviceSource);

const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) {
  fail('generated AndroidManifest.xml was not found');
}
let manifest = readUtf8(manifestPath);

const permissions = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.POST_NOTIFICATIONS',
];
for (const permission of permissions) {
  if (!manifest.includes(`android:name="${permission}"`)) {
    manifest = manifest.replace(
      '<application',
      `    <uses-permission android:name="${permission}" />\n\n    <application`,
    );
  }
}

if (!manifest.includes(`${appId}.UploadForegroundService`)) {
  const serviceEntry = `
        <service
            android:name="${appId}.UploadForegroundService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="dataSync" />
`;
  manifest = manifest.replace('</application>', `${serviceEntry}    </application>`);
}

if (!manifest.includes('${applicationId}.fileprovider')) {
  const providerEntry = `
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/parallax_file_paths" />
        </provider>
`;
  manifest = manifest.replace('</application>', `${providerEntry}    </application>`);
}
writeIfChanged(manifestPath, manifest);

const fileProviderPaths = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <files-path name="files" path="." />
    <cache-path name="cache" path="." />
    <external-files-path name="external_files" path="." />
    <external-cache-path name="external_cache" path="." />
</paths>
`;
writeIfChanged(
  path.join(androidRoot, 'app', 'src', 'main', 'res', 'xml', 'parallax_file_paths.xml'),
  fileProviderPaths,
);

const proguardPath = path.join(androidRoot, 'app', 'proguard-rules.pro');
let proguard = fs.existsSync(proguardPath) ? readUtf8(proguardPath) : '';
const keepBlock = `
# Parallax Android JNI/runtime entry points. Called by name from Rust/JNI.
-keep class ${appId}.MainActivity { *; }
-keep class ${appId}.UploadForegroundService { *; }
`;
if (!proguard.includes(`-keep class ${appId}.MainActivity`)) {
  proguard = `${proguard.trimEnd()}\n${keepBlock}`;
  writeIfChanged(proguardPath, proguard);
}

const staleFiles = [];
for (const file of [
  ...walk(path.join(tauriRoot, 'src'), (candidate) => candidate.endsWith('.rs')),
  ...walk(androidRoot, (candidate) => /\.(kt|java|xml|kts|properties)$/.test(candidate)),
]) {
  if (readUtf8(file).includes(oldPackage)) staleFiles.push(path.relative(appRoot, file));
}
if (staleFiles.length > 0) {
  fail(`stale package references remain:\n${staleFiles.join('\n')}`);
}

console.log(`[prepare-android-runtime] Android runtime prepared for ${appId}`);
