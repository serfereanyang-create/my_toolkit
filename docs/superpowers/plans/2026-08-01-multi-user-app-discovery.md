# Multi-User App Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover and independently manage installed app instances across Android users, while switching freeze operations to suspend/unsuspend so launcher placement is preserved as far as the ROM allows.

**Architecture:** The Shizuku UserService remains the privileged boundary. It will enumerate users and per-user packages, validate `(packageName, userId)`, and execute fixed `pm` commands through `ProcessBuilder`. Room records, navigation arguments, repository methods, workers, and Compose rows will all carry the same composite identity. Existing v1 rows migrate to `userId = 0`.

**Tech Stack:** Kotlin, Android API 28+, Jetpack Compose, Room/KSP, WorkManager, Shizuku UserService/AIDL.

---

## File Map

Create:
- `android-freezer/app/src/main/kotlin/com/example/freezer/shizuku/UserInfo.kt` for the AIDL user DTO.
- `android-freezer/app/src/main/kotlin/com/example/freezer/shizuku/UserAppInfo.kt` for the AIDL app DTO.
- `android-freezer/app/src/main/kotlin/com/example/freezer/repository/AppInstanceKey.kt` for stable navigation/work identity encoding helpers if needed.

Modify:
- `android-freezer/app/src/main/aidl/com/example/freezer/IFreezeService.aidl` to add user/app discovery and `userId` operation parameters.
- `android-freezer/app/src/main/kotlin/com/example/freezer/shizuku/FreezeServiceImpl.kt` for all-user enumeration, validation, app metadata, and suspend commands.
- `android-freezer/app/src/main/kotlin/com/example/freezer/data/FrozenAppEntity.kt` and `FrozenAppDao.kt` for composite identity.
- `android-freezer/app/src/main/kotlin/com/example/freezer/data/AppDatabase.kt` and `FreezerApp.kt` for Room v2 and migration.
- `android-freezer/app/src/main/kotlin/com/example/freezer/repository/AppRepository.kt` for Shizuku discovery, composite CRUD, labels/icons, and operations.
- `android-freezer/app/src/main/kotlin/com/example/freezer/viewmodel/PickerViewModel.kt`, `HomeViewModel.kt`, and `ScheduleViewModel.kt` for user-aware state and calls.
- `android-freezer/app/src/main/kotlin/com/example/freezer/MainActivity.kt` for user-aware schedule navigation.
- `android-freezer/app/src/main/kotlin/com/example/freezer/ui/picker/AppPickerScreen.kt` and `ui/home/HomeScreen.kt` for labels, keys, and callbacks.
- `android-freezer/app/src/main/kotlin/com/example/freezer/ui/schedule/ScheduleScreen.kt` if its callback or title needs user context.
- `android-freezer/app/src/main/kotlin/com/example/freezer/worker/FreezeWorker.kt`, `UnfreezeWorker.kt`, and `ScheduleScheduler.kt` for user-aware work data and unique names.
- `android-freezer/app/src/main/kotlin/com/example/freezer/shizuku/IFreezeService` generated output only through AIDL; do not edit generated sources.

Tests:
- Add focused JVM tests under `android-freezer/app/src/test` for identity encoding, Room migration/DAO behavior where test dependencies permit, and command/validation helpers. Use existing test setup; do not add a new test framework unnecessarily.

---

### Task 1: Add composite identity and Room migration

**Files:**
- Modify `data/FrozenAppEntity.kt`, `data/FrozenAppDao.kt`, `data/AppDatabase.kt`, `FreezerApp.kt`.
- Create a Room migration test if the project already has Android/JVM Room test support; otherwise verify schema through build and a small DAO-focused test using existing dependencies.

- [ ] **Step 1: Change the entity primary key**

Add `userId: Int = 0` to `FrozenAppEntity`, place it before mutable state fields, and replace `@PrimaryKey val packageName` with `@PrimaryKey val packageName: String` plus `@PrimaryKey val userId: Int` using `@Entity(primaryKeys = ["packageName", "userId"])`. Update the KDoc to say that user 0 is the migration default.

- [ ] **Step 2: Update DAO selectors and mutations**

Change every package-only query to include `AND userId = :userId` and update `setFrozen(packageName, userId, frozen)`. Keep ordering by label and userId. Method signatures must be:

```kotlin
suspend fun getApp(packageName: String, userId: Int): FrozenAppEntity?
suspend fun setFrozen(packageName: String, userId: Int, frozen: Boolean)
```

- [ ] **Step 3: Add explicit `MIGRATION_1_2`**

Create a Room `Migration(1, 2)` that creates `frozen_apps_new` with the composite primary key, copies every old column while inserting `0 AS userId`, drops `frozen_apps`, and renames the new table. Preserve existing nullability/default-compatible column types.

- [ ] **Step 4: Register version and migration**

Set `AppDatabase` version to `2`; register `.addMigrations(MIGRATION_1_2)` in `FreezerApp` and do not enable destructive migration.

- [ ] **Step 5: Build the module**

Run:

```bash
cd /c/Users/34516/ZCodeProject/android-freezer
export JAVA_HOME="/c/Users/34516/ZCodeProject/tools/jdk-17"
export ANDROID_HOME="/c/Users/34516/AppData/Local/Android/Sdk"
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:compileDebugKotlin
```

Expected: compilation succeeds after all entity/DAO call sites are updated in later tasks; if it fails now, record the exact caller signatures and continue to Task 2.

---

### Task 2: Extend the Shizuku service for all users and suspend operations

**Files:**
- Modify `IFreezeService.aidl`.
- Create parcelable DTOs in `shizuku/UserInfo.kt` and `shizuku/UserAppInfo.kt` if required by the AIDL compiler.
- Modify `FreezeServiceImpl.kt`.

- [ ] **Step 1: Define stable AIDL DTOs**

Use `Parcelable` AIDL declarations (or primitive encoded strings if the project’s AIDL setup cannot compile Kotlin parcelables) for user and app metadata. Required fields are user ID/name and package name/label/system flag. Keep DTOs minimal and serializable across the Shizuku process.

- [ ] **Step 2: Add AIDL methods**

Expose:

```aidl
List<UserInfo> getUsers();
List<UserAppInfo> getInstalledApps(int userId);
String freeze(String packageName, int userId);
String unfreeze(String packageName, int userId);
String getState(String packageName, int userId);
```

If AIDL class names conflict with Android framework classes, use package-local names such as `ShizukuUserInfo` and `ShizukuAppInfo`.

- [ ] **Step 3: Implement user enumeration**

Run `cmd user list` with `ProcessBuilder("cmd", "user", "list")`. Parse lines matching `UserInfo{<id>:<name>...}` with a regular expression, trim names, and return only IDs greater than or equal to 0. Do not trust user IDs supplied by the client; cache or revalidate the parsed list for every mutating operation.

- [ ] **Step 4: Implement per-user package enumeration**

For a validated user, run `pm list packages --user <id>`. For each package, query `pm path --user <id> <package>` to ensure it is installed for that user. Query label/system metadata using a fixed `cmd package`/`dumpsys` strategy that does not require shell interpolation; if metadata parsing is unavailable, return package name as label and `false` for system flag, allowing the app process to enrich metadata locally.

- [ ] **Step 5: Add strict input validation**

Validate package names with a compiled Android package-name regex such as `[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+`. Validate user IDs against `getUsers()`, and validate package presence against the selected user before `freeze`, `unfreeze`, or `getState`. Return `ERROR: invalid package`, `ERROR: unknown user`, or `ERROR: package not installed for user` without executing a command.

- [ ] **Step 6: Replace shell execution with argument arrays**

Use `ProcessBuilder` with fixed argument lists, collect stdout/stderr, wait for exit, and retain the existing `ERROR:` convention. Implement:

```kotlin
ProcessBuilder("pm", "suspend", "--user", userId.toString(), packageName)
ProcessBuilder("pm", "unsuspend", "--user", userId.toString(), packageName)
ProcessBuilder("pm", "enable", "--user", userId.toString(), packageName)
```

For compatibility, `unfreeze` should treat an already-unsuspended package as success before/while running `enable`; do not silently fall back to `disable-user`.

- [ ] **Step 7: Implement state detection**

Use fixed `pm list packages -d --user <id> <package>` and `pm list packages --user <id> <package>` queries plus a fixed suspension query available on API 36. Return `disabled` if disabled or suspended, `enabled` otherwise, and an explicit error if the package cannot be queried.

- [ ] **Step 8: Compile AIDL and service code**

Run `./gradlew :app:compileDebugKotlin`. Resolve only generated AIDL/type errors before proceeding.

---

### Task 3: Make Repository discovery and operations user-aware

**Files:**
- Modify `repository/AppRepository.kt`.
- Create `repository/AppInstanceKey.kt` only if a shared encoded key is needed by navigation or WorkManager.

- [ ] **Step 1: Expand `InstalledAppInfo`**

Add `userId` and `userName` fields. Keep `packageName`, `label`, `icon`, and `isSystemApp`.

- [ ] **Step 2: Add a Shizuku discovery path**

When Shizuku permission/service is available, call `ShizukuHelper.withService` to fetch all users and each user’s installed apps. Map service metadata into `InstalledAppInfo`, load icons through `PackageManager` where possible, and fall back to the service label. Do not silently return user-0-only data when the service is unavailable; return an empty list or a clear error state consistent with the Picker UI.

- [ ] **Step 3: Update whitelist CRUD**

Change `addToWhitelist`, `getApp`, `freezeApp`, `unfreezeApp`, and `removeFromWhitelist` to accept `userId`. Persist and update only the selected composite key. `freezeAll` and `unfreezeAll` must pass each row’s `userId`.

- [ ] **Step 4: Keep database state transactional with commands**

Set `isFrozen` only when the corresponding service command succeeds. On an operation error, return `Result.failure` and leave the persisted state unchanged.

- [ ] **Step 5: Compile repository callers**

Run `./gradlew :app:compileDebugKotlin` and use compiler errors as the checklist for remaining package-only call sites.

---

### Task 4: Update workers and scheduler identity

**Files:**
- Modify `worker/ScheduleScheduler.kt`, `FreezeWorker.kt`, `UnfreezeWorker.kt`.

- [ ] **Step 1: Add user ID to work data**

Define `KEY_USER_ID = "userId"`. Every request writes both package name and user ID.

- [ ] **Step 2: Make unique work names collision-free**

Use a stable name such as `freeze_<userId>_<packageName>` and `unfreeze_<userId>_<packageName>`, replacing dots only if WorkManager rejects them. Apply the same identity to tags and cancellation.

- [ ] **Step 3: Update workers**

Read and validate both inputs, call `repository.freezeApp(packageName, userId)` or `unfreezeApp(packageName, userId)`, then reload the same composite row and reschedule it. Missing inputs return `Result.failure()`.

- [ ] **Step 4: Verify scheduling behavior**

Run compile and inspect generated work input in a focused unit test or existing test harness. Confirm users 0 and 999 produce different names and input values.

---

### Task 5: Update navigation, ViewModels, and Compose UI

**Files:**
- Modify `MainActivity.kt`, `HomeViewModel.kt`, `PickerViewModel.kt`, `ScheduleViewModel.kt`, `ui/picker/AppPickerScreen.kt`, `ui/home/HomeScreen.kt`, and `ui/schedule/ScheduleScreen.kt` as needed.

- [ ] **Step 1: Make Picker selection composite**

Use a data-class key containing package name and user ID for selection and whitelist checks. Do not use a `Set<String>` keyed only by package.

- [ ] **Step 2: Display user space context**

Show `userName` and/or `userId` under every Picker row. Search must include label, package name, and user name. Use a stable LazyColumn key containing both values.

- [ ] **Step 3: Update Picker callbacks**

`addToWhitelist` receives the selected `InstalledAppInfo` composite identity and saves its label/user ID. Keep already-whitelisted rows disabled by composite identity only.

- [ ] **Step 4: Update Home rows and callbacks**

Pass user ID to toggle, remove, and schedule callbacks. Show user context under the package name. Use `packageName + userId` as the LazyColumn key.

- [ ] **Step 5: Update navigation route**

Add a `userId` route argument to Schedule. Use URL encoding for package names or `Uri.encode` when constructing the route. Schedule loading receives both package name and user ID.

- [ ] **Step 6: Update ViewModels**

Propagate user ID through Home, Picker, and Schedule ViewModels. Keep messages readable, including the user space when the same label appears twice.

- [ ] **Step 7: Build UI code**

Run `./gradlew :app:assembleDebug`. Fix only compile/type issues caused by the composite identity migration.

---

### Task 6: Add focused tests and run device verification

**Files:**
- Create or modify tests under `android-freezer/app/src/test` and, if available, `android-freezer/app/src/androidTest`.

- [ ] **Step 1: Test composite identity behavior**

Add tests proving that two rows with the same package and different user IDs are distinct, and that schedule names differ for user 0 and 999.

- [ ] **Step 2: Test migration/schema**

Use Room migration testing support already present in the project, if available, to create the v1 schema, insert a row, migrate, and assert `userId == 0` and all schedule values remain unchanged. If no test fixture exists, run the app against an existing v1 database and verify startup/build migration logs without adding a new heavy dependency.

- [ ] **Step 3: Run JVM/build verification**

Run:

```bash
cd /c/Users/34516/ZCodeProject/android-freezer
export JAVA_HOME="/c/Users/34516/ZCodeProject/tools/jdk-17"
export ANDROID_HOME="/c/Users/34516/AppData/Local/Android/Sdk"
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Expected: all configured tests pass and APK assembly succeeds.

- [ ] **Step 4: Install and verify on OnePlus**

Install the debug APK over the current install, start Shizuku through the already-approved USB ADB command, grant permission if requested, then verify:

```text
Picker: com.tencent.mm user 0 and user 999 are both visible
Freeze user 0: only primary WeChat is suspended
Freeze user 999: only clone WeChat is suspended
Unfreeze both: both launch and their launcher positions/folders remain where the ROM preserves them
User 10 apps: visible and independently selectable
Schedules: user 0 and user 999 work requests do not cancel each other
```

Record any OnePlus-specific `pm suspend` rejection verbatim rather than silently falling back to `disable-user`.

- [ ] **Step 5: Review final diff**

Run `git diff --check` and `git status --short`; inspect generated/schema changes and ensure no unrelated files were modified.

---

## Self-Review

- The plan covers discovery, composite persistence, privileged operations, scheduling, UI/navigation, migration, and device acceptance from the approved design.
- No destructive migration is used; old rows become user 0 rows.
- All later call sites use `(packageName, userId)` consistently.
- The plan explicitly avoids silent fallback to `disable-user`, because that would violate the layout-preservation requirement.
- AIDL DTO details are constrained to the existing compiler setup; implementation must settle on the smallest compiling parcelable representation without changing scope.
