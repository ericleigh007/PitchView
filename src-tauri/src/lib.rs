use serde_json::Value;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendCapabilities {
    import_pipeline: bool,
    playback_sync: bool,
    stacked_alpha_video: bool,
    pitch_cache: bool,
    audio_only_input: bool,
    ffmpeg_media_ingest: bool,
    vocal_separation_preprocess: bool,
    stem_switching: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaSupport {
    audio_only_extensions: Vec<&'static str>,
    video_extensions: Vec<&'static str>,
    audio_codecs: Vec<&'static str>,
    video_codecs: Vec<&'static str>,
    transparent_video_note: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreprocessSupport {
    ffmpeg_role: &'static str,
    vocal_separation_role: &'static str,
    output_strategy: Vec<&'static str>,
    playback_note: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StemModelOption {
    id: &'static str,
    label: &'static str,
    family: &'static str,
    quality: &'static str,
    strengths: &'static str,
    constraints: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    ffmpeg_available: bool,
    ffprobe_available: bool,
    python_available: bool,
    python_worker_ready: bool,
    ffmpeg_via_python_worker: bool,
    note: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreprocessWorkerContract {
    script_path: &'static str,
    detect_command: &'static str,
    download_model_command_template: &'static str,
    normalize_command_template: &'static str,
    plan_command_template: &'static str,
    run_command_template: &'static str,
}

fn workspace_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| "Unable to resolve workspace root".to_string())
}

fn python_executable() -> String {
    std::env::var("PITCHVIEW_PYTHON").unwrap_or_else(|_| "python".to_string())
}

fn run_preprocess_worker(args: &[String]) -> Result<Value, String> {
    let root = workspace_root()?;
    let python = python_executable();
    eprintln!("[PitchView backend] Starting preprocess worker");
    eprintln!("[PitchView backend] Python: {}", python);
    eprintln!("[PitchView backend] CWD: {}", root.display());
    eprintln!("[PitchView backend] Args: {:?}", args);

    let output = Command::new(&python)
        .current_dir(&root)
        .arg("tools/preprocess_media.py")
        .args(args)
        .output()
        .map_err(|error| format!("Failed to start preprocessing worker: {error}"))?;

    eprintln!("[PitchView backend] Worker exit status: {}", output.status);
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    if !stderr_text.trim().is_empty() {
        eprintln!("[PitchView backend] Worker stderr:\n{}", stderr_text);
    }
    if !stdout_text.trim().is_empty() {
        eprintln!("[PitchView backend] Worker stdout:\n{}", stdout_text);
    }

    if output.stdout.is_empty() && !output.status.success() {
        let stderr = stderr_text.trim().to_string();
        return Err(if stderr.is_empty() {
            "Preprocessing worker failed without output".to_string()
        } else {
            stderr
        });
    }

    let parsed = serde_json::from_str::<Value>(&stdout_text)
        .map_err(|error| format!("Failed to parse preprocessing worker output: {error}. Output: {stdout_text}"))?;

    if output.status.success() {
        Ok(parsed)
    } else {
        Err(parsed
            .get("stderr")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Preprocessing worker failed")
            .to_string())
    }
}

#[tauri::command]
fn detect_preprocess_backends() -> Result<Value, String> {
    run_preprocess_worker(&["detect".to_string()])
}

#[tauri::command]
fn run_preprocess_job(
    source: String,
    output_dir: String,
    model_id: String,
    model_file: Option<String>,
    dry_run: bool,
) -> Result<Value, String> {
    let mut args = vec![
        "run".to_string(),
        "--source".to_string(),
        source,
        "--output-dir".to_string(),
        output_dir,
        "--model-id".to_string(),
        model_id,
    ];

    if let Some(model_file) = model_file {
        if !model_file.is_empty() {
            args.push("--model-file".to_string());
            args.push(model_file);
        }
    }

    if dry_run {
        args.push("--dry-run".to_string());
    }

    run_preprocess_worker(&args)
}

#[tauri::command]
fn get_backend_capabilities() -> BackendCapabilities {
    BackendCapabilities {
        import_pipeline: false,
        playback_sync: true,
        stacked_alpha_video: true,
        pitch_cache: false,
        audio_only_input: true,
        ffmpeg_media_ingest: true,
        vocal_separation_preprocess: true,
        stem_switching: true,
    }
}

#[tauri::command]
fn describe_supported_media() -> MediaSupport {
    MediaSupport {
        audio_only_extensions: vec!["wav", "mp3", "flac", "m4a", "aiff"],
        video_extensions: vec!["mp4", "mov", "mkv", "webm"],
        audio_codecs: vec!["mp3", "aac", "pcm_s16le", "pcm_f32le", "flac"],
        video_codecs: vec!["h264", "hevc", "prores", "vp9"],
        transparent_video_note: "MVP should prioritize formats that preserve alpha, such as ProRes 4444 or VP9/WebM alpha, while allowing opaque video files to contribute audio and pitch data.",
    }
}

#[tauri::command]
fn describe_media_boundary() -> &'static str {
    "Media import should be normalized through FFmpeg so audio-only files and video files with varied container and codec combinations can feed the same sync, playback, and pitch-analysis pipeline. FFmpeg is a media boundary tool here, not the stem-separation engine. Transparent video remains a first-class path when the source format preserves alpha."
}

#[tauri::command]
fn describe_preprocess_pipeline() -> PreprocessSupport {
    PreprocessSupport {
        ffmpeg_role: "Probe source containers, extract normalized audio, and remux playable outputs for preview around the AI model pipeline.",
        vocal_separation_role: "Create derived vocal and accompaniment stems through an AI model backend such as Audio Separator or Demucs before pitch analysis.",
        output_strategy: vec![
            "Keep the original source as the main playable asset.",
            "Generate stem audio files as sibling assets for vocals and accompaniment.",
            "Optionally remux stems into additional playable tracks when the target container supports multiple audio tracks.",
        ],
        playback_note: "The UI should allow switching between original audio and derived stems even when the playable preview is backed by separate sidecar audio files instead of a multi-track container.",
    }
}

#[tauri::command]
fn describe_stem_models() -> Vec<StemModelOption> {
    vec![
        StemModelOption {
            id: "vocals_mel_band_roformer",
            label: "Vocals Mel-Band Roformer",
            family: "Roformer / Audio Separator",
            quality: "high",
            strengths: "Strong dedicated vocal extraction with good clarity and reduced accompaniment bleed on dense mixes.",
            constraints: "Requires the matching checkpoint file and a compatible Audio Separator style backend.",
        },
        StemModelOption {
            id: "htdemucs_ft",
            label: "HTDemucs FT",
            family: "Demucs",
            quality: "high",
            strengths: "Strong overall vocal isolation with good musical balance.",
            constraints: "Heavier runtime and memory footprint than lighter MDX-style models.",
        },
        StemModelOption {
            id: "htdemucs_6s",
            label: "HTDemucs 6 Stem",
            family: "Demucs",
            quality: "high",
            strengths: "Can separate additional instrument families beyond vocal and accompaniment.",
            constraints: "Longest processing path of the included options.",
        },
        StemModelOption {
            id: "mdx23c",
            label: "MDX23C",
            family: "MDX",
            quality: "balanced",
            strengths: "Strong vocal separation with a practical quality to speed tradeoff.",
            constraints: "May leave more accompaniment bleed than HTDemucs on dense mixes.",
        },
        StemModelOption {
            id: "uvr_mdx_karaoke",
            label: "UVR MDX Karaoke",
            family: "UVR / MDX",
            quality: "balanced",
            strengths: "Useful when accompaniment-first output is the main target.",
            constraints: "Less flexible than full multi-stem model families.",
        },
        StemModelOption {
            id: "spleeter_2stem",
            label: "Spleeter 2 Stem",
            family: "Spleeter",
            quality: "fast",
            strengths: "Fast turnaround and simple deployment.",
            constraints: "Lower separation quality on difficult mixes.",
        },
        StemModelOption {
            id: "openunmix",
            label: "Open-Unmix",
            family: "Open-Unmix",
            quality: "balanced",
            strengths: "Stable open model with broad ecosystem familiarity.",
            constraints: "Usually outperformed by newer Demucs and MDX variants for vocals.",
        },
    ]
}

#[tauri::command]
fn get_tool_status() -> ToolStatus {
    ToolStatus {
        ffmpeg_available: false,
        ffprobe_available: false,
        python_available: true,
        python_worker_ready: true,
        ffmpeg_via_python_worker: true,
        note: "The current workspace validated a Python preprocessing worker, confirmed FFmpeg availability through imageio-ffmpeg, downloaded the vocals_mel_band_roformer checkpoint into the local models cache, and completed a real audio-separator Roformer stem run on the sample media.",
    }
}

#[tauri::command]
fn describe_preprocess_worker() -> PreprocessWorkerContract {
    PreprocessWorkerContract {
        script_path: "tools/preprocess_media.py",
        detect_command: "python tools/preprocess_media.py detect",
        download_model_command_template: "python tools/preprocess_media.py download-model --model-id <model> [--model-file <checkpoint>]",
        normalize_command_template: "python tools/preprocess_media.py normalize --source <input> --output <wav>",
        plan_command_template: "python tools/preprocess_media.py plan --source <input> --output-dir <out> --model-id <model> [--model-file <checkpoint>] --dry-run",
        run_command_template: "python tools/preprocess_media.py run --source <input> --output-dir <out> --model-id <model> [--model-file <checkpoint>]",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_capabilities,
            get_tool_status,
            detect_preprocess_backends,
            describe_preprocess_worker,
            describe_supported_media,
            describe_preprocess_pipeline,
            describe_stem_models,
            describe_media_boundary,
            run_preprocess_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}