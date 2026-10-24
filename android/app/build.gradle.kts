// Inhouse Learn Android shell. Read android/README.md before changing the
// package, the version or anything about signing.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.inhouse.learn"
    compileSdk = 35

    defaultConfig {
        // Permanent: installed apps only update from the same package ID and key.
        applicationId = "com.inhouse.learn"
        minSdk = 26
        targetSdk = 35
        // Raise both for every published APK; versionCode must always grow.
        versionCode = 8
        versionName = "1.0.7"
    }

    buildTypes {
        release {
            // Signed outside Gradle with the permanent Inhouse key (CI only).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

dependencies {
    implementation("androidx.activity:activity:1.9.3")
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
