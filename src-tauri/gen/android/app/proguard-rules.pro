# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Called from Rust over JNI (src/transfer_notice.rs); nothing in Java/Kotlin calls them, so R8
# would strip them.
-keep class app.kybl.mobile.TransferService {
    public static void fromRust(android.content.Context, java.lang.String);
}
-keep class app.kybl.mobile.MainActivity {
    public static int screens();
}
