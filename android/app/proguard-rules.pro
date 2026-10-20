# The shell has no reflection or JavaScript interfaces: the web talks to it
# through an origin-restricted WebMessageListener (see MainActivity).

# Inhouse services updater (UPDATER.md): keep its classes exactly as compiled.
# The frozen installer was verified on a real phone without shrinking, and its
# WebView bridges are called by name from the bundled updater page.
-keep class com.inhouse.services.updater.** { *; }
