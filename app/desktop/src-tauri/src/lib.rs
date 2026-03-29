use chrono::Local;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
struct DesktopCapabilities {
    desktop_shell: &'static str,
    preprocessing_entrypoint: &'static str,
    browser_mode: &'static str,
}

#[derive(Deserialize)]
struct ProjectStatePayload {
    project_json: String,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf()
}

fn preprocess_script() -> PathBuf {
    repo_root().join("tools").join("preprocess_media.py")
}

fn collect_python_candidates() -> Vec<(String, Vec<String>)> {
    let local_venv_python = repo_root().join(".venv").join("Scripts").join("python.exe");
    if local_venv_python.exists() {
        return vec![(local_venv_python.display().to_string(), Vec::new())];
    }

    Vec::new()
}

fn e2e_media_paths() -> Option<Vec<String>> {
    let raw = std::env::var("PITCHVIEW_E2E_MEDIA_PATHS").ok()?;
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with('[') {
        return serde_json::from_str::<Vec<String>>(trimmed)
            .ok()
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|path| path.trim().to_string())
                    .filter(|path| !path.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|paths| !paths.is_empty());
    }

    let paths = trimmed
        .split(';')
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();

    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn project_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("project-state.json"))
}

fn analysis_dir_for(app: &AppHandle, media_path: &str) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    media_path.hash(&mut hasher);
    let digest = format!("{:x}", hasher.finish());
    let directory = app_data_dir(app)?.join("analysis-cache").join(digest);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn diagnostics_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("pitchview.log"))
}

fn format_log_timestamp() -> String {
    Local::now().format("%H:%M:%S%.3f").to_string()
}

fn append_diagnostics_log(app: &AppHandle, message: &str) {
    let Ok(path) = diagnostics_log_path(app) else {
        return;
    };

    let timestamp = format_log_timestamp();

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

fn read_diagnostics_log_lines(app: &AppHandle, max_lines: usize) -> Result<Vec<String>, String> {
    let path = diagnostics_log_path(app)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut lines = content
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();

    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }

    Ok(lines)
}

fn run_python_script(app: &AppHandle, script: &Path, arguments: &[String]) -> Result<String, String> {
    let candidates = collect_python_candidates();
    let mut last_error = String::from("PitchView requires the repository Python environment at .venv\\Scripts\\python.exe.");

    for (executable, prefix_args) in candidates {
        let mut command = Command::new(&executable);
        command.args(prefix_args);
        command.arg(script);
        command.args(arguments);
        command.current_dir(repo_root());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        append_diagnostics_log(
            app,
            &format!(
                "Running preprocessing command: {} {} {}",
                executable,
                script.display(),
                arguments.join(" ")
            ),
        );

        match command.spawn() {
            Ok(mut child) => {
                let Some(stdout_pipe) = child.stdout.take() else {
                    last_error = "Preprocessing stdout pipe was unavailable.".to_string();
                    append_diagnostics_log(app, &last_error);
                    continue;
                };
                let Some(stderr_pipe) = child.stderr.take() else {
                    last_error = "Preprocessing stderr pipe was unavailable.".to_string();
                    append_diagnostics_log(app, &last_error);
                    continue;
                };

                let stderr_app = app.clone();
                let stderr_handle = thread::spawn(move || -> Result<String, String> {
                    let mut collected = String::new();
                    let mut reader = BufReader::new(stderr_pipe);

                    loop {
                        let mut line = String::new();
                        let bytes_read = reader.read_line(&mut line).map_err(|error| error.to_string())?;
                        if bytes_read == 0 {
                            break;
                        }

                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if trimmed.is_empty() {
                            continue;
                        }

                        if !collected.is_empty() {
                            collected.push('\n');
                        }
                        collected.push_str(trimmed);
                        append_diagnostics_log(&stderr_app, trimmed);
                    }

                    Ok(collected)
                });

                let stdout_handle = thread::spawn(move || -> Result<String, String> {
                    let mut collected = String::new();
                    let mut reader = BufReader::new(stdout_pipe);
                    reader.read_to_string(&mut collected).map_err(|error| error.to_string())?;
                    Ok(collected)
                });

                let status = child.wait().map_err(|error| error.to_string())?;
                let stdout = stdout_handle
                    .join()
                    .map_err(|_| "Failed to read preprocessing stdout.".to_string())??;
                let stderr = stderr_handle
                    .join()
                    .map_err(|_| "Failed to read preprocessing stderr.".to_string())??;

                if status.success() {
                    if !stderr.trim().is_empty() {
                        append_diagnostics_log(app, &format!("Preprocessing stderr summary: {}", stderr.trim()));
                    }
                    return Ok(stdout);
                }

                last_error = if stderr.trim().is_empty() {
                    format!("Preprocessing failed with status {:?}.", status.code())
                } else {
                    stderr
                };
                append_diagnostics_log(
                    app,
                    &format!(
                        "Preprocessing failed with status {:?}: {}",
                        status.code(),
                        last_error.trim()
                    ),
                );
            }
            Err(error) => {
                last_error = error.to_string();
                append_diagnostics_log(app, &format!("Preprocessing launch error: {last_error}"));
            }
        }
    }

    Err(last_error)
}

fn analyze_media_files_blocking(
    app: AppHandle,
    paths: Vec<String>,
    separate_stems: Option<bool>,
    stem_model: Option<String>,
    pitch_model: Option<String>,
    pitch_source_kind: Option<String>,
    processing_device: Option<String>,
    bypass_cache: Option<bool>,
) -> Result<Vec<Value>, String> {
    let script = preprocess_script();
    let mut results = Vec::new();

    for media_path in paths {
        append_diagnostics_log(&app, &format!("Starting analysis for {}", media_path));
        let output_dir = analysis_dir_for(&app, &media_path)?;
        let mut arguments = vec![
            "analyze-media".to_string(),
            media_path.clone(),
            output_dir.display().to_string(),
        ];

        if separate_stems.unwrap_or(false) {
            arguments.push("--separate-stems".to_string());
            if let Some(model) = stem_model.clone() {
                arguments.push("--stem-model".to_string());
                arguments.push(model);
            }
        }

        if let Some(model) = pitch_model.clone() {
            arguments.push("--pitch-model".to_string());
            arguments.push(model);
        }

        if let Some(source_kind) = pitch_source_kind.clone() {
            arguments.push("--pitch-source".to_string());
            arguments.push(source_kind);
        }

        if let Some(device) = processing_device.clone() {
            arguments.push("--processing-device".to_string());
            arguments.push(device);
        }

        if bypass_cache.unwrap_or(false) {
            arguments.push("--bypass-cache".to_string());
        }

        let stdout = run_python_script(&app, &script, &arguments)?;
        let payload: Value = serde_json::from_str(&stdout).map_err(|error| {
            append_diagnostics_log(
                &app,
                &format!(
                    "Preprocessing returned invalid JSON for {}: {} | stdout head: {}",
                    media_path,
                    error,
                    stdout.chars().take(600).collect::<String>()
                ),
            );
            error.to_string()
        })?;
        append_diagnostics_log(&app, &format!("Finished analysis for {}", media_path));
        results.push(payload);
    }

    Ok(results)
}

#[tauri::command]
fn get_desktop_capabilities() -> DesktopCapabilities {
    DesktopCapabilities {
        desktop_shell: "tauri",
        preprocessing_entrypoint: "tools/preprocess_media.py",
        browser_mode: "test-only",
    }
}

#[tauri::command]
fn pick_media_files() -> Vec<String> {
    if let Some(paths) = e2e_media_paths() {
        return paths;
    }

    FileDialog::new()
        .add_filter("Media", &["wav", "mp3", "flac", "m4a", "aac", "ogg", "mp4", "mov", "mkv", "webm"])
        .pick_files()
        .unwrap_or_default()
        .iter()
        .map(|path| path.display().to_string())
        .collect()
}

#[tauri::command]
fn save_project_state(app: AppHandle, payload: ProjectStatePayload) -> Result<(), String> {
    let path = project_state_path(&app)?;
    fs::write(path, payload.project_json).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_project_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = project_state_path(&app)?;

    if !path.exists() {
        return Ok(None);
    }

    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn append_diagnostics_entry(app: AppHandle, message: String) {
    append_diagnostics_log(&app, &message);
}

#[tauri::command]
fn read_diagnostics_log(app: AppHandle, max_lines: Option<usize>) -> Result<Vec<String>, String> {
    read_diagnostics_log_lines(&app, max_lines.unwrap_or(200))
}

#[tauri::command]
fn clear_diagnostics_log(app: AppHandle) -> Result<(), String> {
    let path = diagnostics_log_path(&app)?;

    if path.exists() {
        fs::write(path, "").map_err(|error| error.to_string())?;
    }

    append_diagnostics_log(&app, "Diagnostics log cleared from the workspace UI.");
    Ok(())
}

#[tauri::command]
async fn analyze_media_files(
    app: AppHandle,
    paths: Vec<String>,
    separate_stems: Option<bool>,
    stem_model: Option<String>,
    pitch_model: Option<String>,
    pitch_source_kind: Option<String>,
    processing_device: Option<String>,
    bypass_cache: Option<bool>,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analyze_media_files_blocking(
            app,
            paths,
            separate_stems,
            stem_model,
            pitch_model,
            pitch_source_kind,
            processing_device,
            bypass_cache,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_desktop_capabilities,
            pick_media_files,
            save_project_state,
            load_project_state,
            append_diagnostics_entry,
            read_diagnostics_log,
            clear_diagnostics_log,
            analyze_media_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running PitchView desktop host");
}
