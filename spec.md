# Badminton AI Coach — Project Specification

**File:** `spec.md`  
**Project type:** Personal web application  
**Primary purpose:** Video-based badminton movement analysis, tactical coaching, shuttlecock tracking, and long-term performance tracking.

---

## 1. Project Overview

Build a personal AI badminton coaching application that analyzes uploaded match and training videos. The application should identify players, estimate body poses, track movement across the court, detect badminton shots, track the shuttlecock where possible, and generate evidence-based coaching feedback.

The application must maintain a persistent library of uploaded matches. Once a video has been processed successfully, its original recording, analysis results, event timeline, and user corrections must remain available for future sessions without requiring reprocessing.

The application is intended initially for one primary user and should prioritize privacy, explainable feedback, historical comparisons, and extensibility.

### Core principles

1. Analyze a video once and reuse the stored results.
2. Preserve the original video permanently unless the user explicitly deletes it.
3. Separate video processing from the web interface and API.
4. Prefer existing pretrained computer-vision models over training models from scratch.
5. Clearly distinguish measured facts, estimated values, and coaching hypotheses.
6. Allow manual corrections when AI predictions are incorrect.
7. Make expensive or unreliable features optional and progressively improve them.
8. Do not claim accuracy that has not been measured.

---

## 2. Product Goals

The system must support the following capabilities.

### 2.1 Video management

- Upload badminton videos.
- Store original video files durably.
- Maintain a searchable match library.
- Record date, duration, opponent label, session type, notes, and user-defined tags.
- Display processing progress and failures.
- Resume or retry failed processing jobs without corrupting existing data.
- Replay previously processed videos at any time.
- Delete videos and their associated data explicitly.
- Export annotated videos and analysis reports.

### 2.2 Player analysis

- Detect players and assign track identifiers.
- Allow the user to select their own player.
- Maintain player identity across frames as consistently as possible.
- Estimate body pose and joint coordinates.
- Render green skeleton lines and joint markers.
- Track player positions and movement paths.
- Calculate movement and recovery metrics.
- Preserve confidence scores and visibility information.

### 2.3 Shuttlecock analysis

- Detect the shuttlecock where visible.
- Estimate its position in each frame or observed interval.
- Maintain a timestamped trajectory.
- Render a visible marker over the shuttle.
- Display a configurable movement trail.
- Distinguish observed positions from interpolated or predicted positions.
- Estimate speed only when sufficient tracking and calibration data exist.
- Provide confidence scores and uncertainty warnings.
- Allow manual correction of tracking errors.

### 2.4 Coaching

- Segment matches into rallies where possible.
- Detect and classify shot events.
- Generate a timestamped shot-by-shot timeline.
- Analyze positioning, recovery, movement, and shot selection.
- Explain why a recommendation was made.
- Identify recurring weaknesses across matches.
- Recommend drills relevant to detected weaknesses.
- Compare current performance against the user's own historical baseline.

---

## 3. Target User and Scope

### Initial user

One primary user who records badminton singles matches and training sessions.

The architecture should allow multiple players in a recording, but multi-account collaboration, public sharing, and commercial subscription features are outside the initial scope.

### Initial camera assumptions

Support ordinary phone recordings as the first target.

The system should tolerate different resolutions and frame rates, but analysis quality will depend on:

- Camera angle and distance.
- Lighting and motion blur.
- Frame rate and shutter speed.
- Player visibility and overlap.
- Shuttlecock visibility.
- Visibility of court boundaries and markings.
- Camera movement during recording.

The application must display warnings when footage is unsuitable for reliable analysis.

---

## 4. Recommended Technology Stack

### Frontend

- Next.js with TypeScript.
- React.
- Tailwind CSS.
- A charting library such as Recharts.
- HTML video playback with a synchronized canvas overlay.

### Backend

- Python and Django Rest Framework.
- PostgreSQL for persistent application and analysis data.
- SQLAlchemy and Alembic for database access and migrations.
- Redis with Celery or an equivalent background-job system.
- OpenCV for video decoding, frame extraction, geometric transformations, and rendering.
- PyTorch for computer-vision inference.

### Computer vision

Use replaceable model adapters rather than tightly coupling the application to one model.

Potential components:

- MediaPipe Pose or another suitable human pose-estimation model.
- YOLO or another suitable detector for player localization.
- ByteTrack or another tracker for player identity continuity.
- TrackNet or a compatible shuttlecock detector/tracker.
- A temporal model for shot-event detection and classification.

These are candidates to evaluate, not mandatory dependencies. Confirm model compatibility, licensing, available weights, maintenance status, and GPU requirements before adoption.

### Storage

- PostgreSQL: metadata, event records, tracking summaries, user settings, and coaching reports.
- Persistent filesystem or object storage: original videos and generated media.
- Persistent filesystem or object storage: versioned analysis artifacts.
- Redis: temporary job coordination, not the permanent record of processing status.

Local storage is acceptable for the first version, provided that files survive application restarts and backups are implemented.

---

## 5. System Architecture

Separate the system into the following components.

### 5.1 Web frontend

Responsible for:

- Upload interface.
- Match library.
- Video player.
- Skeleton and shuttle overlays.
- Playback speed controls.
- Frame-by-frame inspection.
- Court visualization.
- Shot timeline.
- Historical analytics.
- Coaching reports.
- Manual correction tools.

### 5.2 Application API

Responsible for:

- Match metadata.
- Upload authorization and validation.
- Processing-job creation.
- Job status.
- Analysis retrieval.
- Player selection.
- Event corrections.
- Historical queries.
- Report generation.
- Video deletion and export requests.

The API must not perform long-running video analysis inside an ordinary HTTP request.

### 5.3 Background processing worker

Responsible for:

- Video validation and metadata extraction.
- Frame decoding and timestamp normalization.
- Player detection and tracking.
- Pose estimation.
- Shuttlecock detection and tracking.
- Court calibration.
- Rally segmentation.
- Shot-event analysis.
- Metric calculation.
- Persisting results and processing status.
- Optional generation of annotated video.

Workers must support retries, bounded resource consumption, and idempotent job execution.

### 5.4 Coaching service

Consumes structured analysis results and generates coaching feedback.

It must not invent measurements or claim to have observed events absent from the stored analysis.

The coaching service should combine deterministic metrics, badminton-specific rules, historical comparisons, and optionally a language model.

---

## 6. Video Upload and Permanent Replay

This is a foundational requirement.

### 6.1 Upload workflow

1. User selects a video.
2. Frontend uploads the video to persistent storage.
3. Backend validates the file and extracts metadata.
4. Backend creates a match record.
5. Backend creates an analysis job.
6. Frontend displays processing status.
7. Background worker processes the video.
8. Worker stores results and updates the job status.
9. Frontend displays the completed analysis.
10. The match appears in the permanent library.

The user must be able to leave the page or close the browser during processing. The job must continue independently.

### 6.2 Supported input

Initially support common MP4 recordings using H.264 video. Support other formats when the installed FFmpeg build can decode them reliably.

Record:

- Original filename.
- File size.
- Video duration.
- Width and height.
- Nominal and, where possible, actual frame rate.
- Codec.
- Upload timestamp.
- Content checksum.
- Processing status.

Enforce configurable upload-size and duration limits.

### 6.3 Persistent assets

Store the following independently:

- Original video.
- Analysis metadata.
- Player-track records.
- Pose and trajectory data.
- Shot-event timeline.
- Court calibration.
- Computed metrics.
- Coaching reports.
- User corrections.
- Optional annotated video.
- Optional thumbnails and preview clips.

Every asset must be associated with the correct match and analysis version.

### 6.4 Replay requirements

After successful processing, the user must be able to:

- Reopen the match after logging out and back in.
- Replay the original video.
- Seek to any timestamp.
- Change playback speed.
- Step frame by frame.
- Toggle skeleton overlay.
- Toggle shuttle marker and trail.
- Toggle movement trails.
- Jump to a shot event.
- View the court position at a selected timestamp.
- Reopen previously generated coaching reports.
- Compare the match with older sessions.

Replay must not launch a new analysis job unless the user explicitly requests reprocessing.

### 6.5 Storage and backup

- Store files outside temporary directories and application containers.
- Use stable asset identifiers rather than exposing arbitrary filesystem paths.
- Configure backups for database records and media files.
- Verify backup restoration periodically.
- Avoid silently deleting source videos when reprocessing fails.
- Provide a clear delete operation that removes associated media and records according to the retention policy.

If storage becomes unavailable, show a recoverable error rather than marking missing files as successfully processed.

---

## 7. Processing Pipeline

Implement the pipeline as independently testable stages.

### Stage 1: Ingestion

- Validate file type, size, and duration.
- Compute a checksum.
- Extract video metadata.
- Generate a stable match identifier.
- Record source timestamps and frame-rate information.
- Create a processing-job record.

### Stage 2: Frame preparation

- Decode frames using OpenCV or FFmpeg.
- Preserve accurate timestamp mapping.
- Normalize image orientation.
- Avoid unnecessary full-resolution copies.
- Generate reduced-resolution frames for models that do not require full resolution.
- Preserve original frame coordinates for overlays.

### Stage 3: Player detection and tracking

- Detect both players.
- Maintain track IDs.
- Estimate bounding boxes.
- Record detection confidence.
- Handle brief occlusion and missed detections.
- Allow manual player selection and track correction.

### Stage 4: Pose estimation

- Estimate body joints for each detected player.
- Record normalized and pixel coordinates.
- Store joint confidence and visibility.
- Render green lines connecting appropriate anatomical joints.
- Flag low-confidence joints instead of treating them as precise observations.

### Stage 5: Shuttlecock tracking

- Detect the shuttle in individual frames.
- Associate detections across time.
- Estimate a trajectory.
- Mark uncertain observations.
- Interpolate brief gaps only when justified.
- Avoid presenting long interpolated gaps as observed shuttle movement.

### Stage 6: Court calibration

- Detect or manually mark court boundaries and relevant corners.
- Estimate a perspective transformation.
- Map player foot positions to standardized court coordinates when calibration is valid.
- Store calibration parameters and confidence.
- Support manual correction.

### Stage 7: Rally and shot analysis

- Estimate rally start and end times.
- Identify candidate contact events.
- Classify shot types where sufficient evidence exists.
- Estimate contact timestamps and landing locations where possible.
- Record classification confidence.
- Allow manual event correction.

### Stage 8: Metrics and coaching

- Calculate movement metrics.
- Identify recurring patterns.
- Compare results with historical baselines.
- Generate evidence-grounded coaching reports.
- Store the report and the exact analysis version used.

### Stage 9: Finalization

- Validate output integrity.
- Persist all completed artifacts.
- Mark the job completed only after required results are durable.
- Keep optional-feature failures separate from the success of core analysis.

For example, a failed shuttle tracker should not destroy a valid skeleton analysis.

---

## 8. Skeleton Overlay

### Required behavior

Display a green stick-figure overlay for the selected player.

Track available landmarks, including:

- Nose and head landmarks where useful.
- Shoulders.
- Elbows.
- Wrists.
- Hips.
- Knees.
- Ankles.
- Feet where supported by the model.

Only draw connections for landmarks with sufficient confidence.

### Interface controls

- Toggle skeleton.
- Toggle joint markers.
- Adjust overlay opacity.
- Select tracked player.
- Display confidence indicators.
- Choose original or annotated viewing mode.
- Display movement trails.
- Select an individual frame.

### Data storage

Store timestamped pose records. Use a documented coordinate convention and a versioned schema.

Do not store every model's internal tensor or intermediate image unless needed for a documented feature.

---

## 9. Shuttlecock Tracking and Highlighting

This is a first-class feature, implemented progressively.

### 9.1 Visual highlighting

The user must be able to enable:

- A marker at the estimated shuttle position.
- A short trajectory trail.
- A longer trail for selected rally analysis.
- A distinct visual treatment for uncertain tracking.
- A mode that displays the shuttle trajectory without the skeleton.
- A mode that combines skeleton, shuttle, and player movement.

The overlay must remain synchronized with the video during seeking, pausing, frame stepping, and variable-speed playback.

### 9.2 Tracking records

Each observation should contain:

- Match identifier.
- Analysis version.
- Timestamp.
- Frame index where applicable.
- X and Y image coordinates.
- Detection confidence.
- Observation status: detected, interpolated, predicted, or unavailable.
- Optional court-relative coordinates when calibrated.
- Optional tracking-quality information.

Use sparse or compressed storage where appropriate. A complete per-frame trajectory need not be duplicated in multiple database tables.

### 9.3 Missing observations

The shuttle may be:

- Motion-blurred.
- Too small to detect.
- Behind a player or racket.
- Outside the frame.
- Lost against a visually complex background.

When tracking fails:

- Do not invent a precise position.
- Mark the interval as uncertain.
- Limit interpolation to configurable short gaps.
- Resume tracking when a credible detection returns.
- Expose tracking quality to the UI.

### 9.4 Shuttle speed

Implement speed estimation only after reliable tracking and court calibration are available.

Potential outputs:

- Image-space displacement per second.
- Approximate physical speed over an observed trajectory segment.
- Estimated speed around a contact event, if the available temporal resolution supports it.
- Confidence and measurement limitations.

Do not label average segment speed as peak smash speed.

Ordinary low-frame-rate footage may be insufficient for trustworthy peak-speed estimates. Treat those estimates as experimental and avoid displaying false precision.

---

## 10. Court Mapping and Movement Analysis

### Court representation

Use a standardized badminton court coordinate system with documented dimensions and coordinate orientation.

The system should support a top-down court visualization and map observations into court coordinates only when calibration is sufficiently reliable.

### Metrics

Calculate when supported by valid data:

- Player position over time.
- Movement paths.
- Heatmaps.
- Time spent in court regions.
- Distance travelled.
- Average and peak observed movement speed.
- Recovery time after contact.
- Time to reach a target region.
- Time spent away from a suitable base position.
- Repeated movement patterns.
- Coverage of front and rear corners.

Do not assume the geometric court center is always the tactically correct recovery position. Coaching should consider shot type, opponent position, and likely replies.

### Limitations

A monocular video does not directly provide exact three-dimensional player position. Perspective, body orientation, and occlusion can distort estimated foot locations.

Label uncertain or uncalibrated measurements accordingly.

---

## 11. Shot-by-Shot Timeline

Create a searchable, timestamped event timeline.

Potential shot categories:

- Serve.
- Clear.
- Smash.
- Drop.
- Drive.
- Lift.
- Net shot.
- Block or defensive return.
- Push.
- Unknown or unclassified shot.

Do not force a classification when confidence is insufficient.

Each event should contain:

- Timestamp.
- Player track ID.
- Event type.
- Classification confidence.
- Estimated contact point or interval.
- Available shuttle trajectory.
- Estimated landing area.
- Court position.
- Rally identifier.
- Outcome information where detectable.
- Evidence and uncertainty notes.
- Manual correction history.

### Interface

Selecting an event must seek to the corresponding video timestamp and show the relevant overlays.

Provide frame-by-frame inspection around the event.

Support correction of event type, player identity, and timestamp. Corrections must persist and be used in subsequent analysis without changing the original video.

---

## 12. Coaching Engine

### Coaching principles

The system should behave as an evidence-based assistant, not an infallible professional coach.

It must distinguish:

1. Directly observed measurements.
2. Model estimates.
3. Tactical interpretations.
4. Suggested actions.
5. Uncertain or unsupported conclusions.

### Example feedback

**Observation:** The player's recovery toward the central area began relatively late after a rear-court shot.

**Evidence:** The recorded pose and calibrated foot positions show a delay between the estimated contact time and the start of forward movement.

**Interpretation:** The delay may have reduced readiness for the opponent's next front-court shot.

**Recommendation:** Practise rear-court recovery drills with a controlled return toward a balanced base position.

**Confidence:** Moderate, depending on the reliability of contact detection and court mapping.

These are illustrative statements, not guaranteed conclusions.

### Coaching topics

- Recovery movement.
- Split-step timing where observable.
- Preparation and balance.
- Rear-court movement.
- Front-court interception.
- Shot selection.
- Defensive response.
- Attack opportunities.
- Positioning relative to the opponent.
- Repeated tactical weaknesses.
- Drill recommendations.

### Recommendation structure

Each recommendation should include:

- A concise title.
- Relevant match and timestamp.
- Observed evidence.
- Explanation.
- Suggested correction.
- Recommended drill.
- Confidence level.
- Known limitations.

The language model must receive validated structured data and must not invent timestamps, distances, shot classifications, or measurements.

---

## 13. Historical Analytics

Every completed analysis must be stored with its version and processing configuration.

### Match comparisons

Allow the user to compare:

- Two selected matches.
- Recent matches against an older baseline.
- Training sessions over a selected period.
- The frequency of specific movement errors.
- Shot distributions and outcomes.
- Movement metrics under comparable conditions.

### Trends

Potential historical trends include:

- Recovery-time distribution.
- Movement coverage.
- Backhand-corner movement patterns.
- Front-court interception success.
- Defensive and attacking shot distribution.
- Repeated late-recovery situations.
- Changes in observed movement speed.
- Changes in shot effectiveness.

Metrics must have consistent definitions and units across analysis versions.

When model changes affect measurements, preserve the original results and identify incompatible comparisons.

### Personal coaching profile

Store user-defined goals and preferences, such as:

- Playing style.
- Priority weaknesses.
- Training goals.
- Preferred drills.
- Historical baselines.

Allow the user to edit this profile.

---

## 14. Database Model

Use PostgreSQL with explicit foreign keys and migrations.

### `matches`

- `id`
- `title`
- `recorded_at`
- `uploaded_at`
- `duration_ms`
- `source_asset_id`
- `width`
- `height`
- `fps_num`
- `fps_den`
- `codec`
- `file_size_bytes`
- `checksum`
- `status`
- `notes`
- `created_at`
- `updated_at`

### `assets`

- `id`
- `match_id`
- `asset_type`
- `storage_key`
- `mime_type`
- `size_bytes`
- `checksum`
- `created_at`

Asset types include original video, annotated video, thumbnail, and report.

### `analysis_runs`

- `id`
- `match_id`
- `status`
- `analysis_version`
- `pipeline_config`
- `started_at`
- `completed_at`
- `error_code`
- `error_message`
- `created_at`

### `player_tracks`

- `id`
- `analysis_run_id`
- `track_label`
- `is_selected_player`
- `identity_confidence`

### `pose_observations`

- `id`
- `analysis_run_id`
- `player_track_id`
- `timestamp_ms`
- `frame_index`
- `pose_data`
- `overall_confidence`

Use an efficient storage format for joint coordinates and confidence values.

### `shuttle_observations`

- `id`
- `analysis_run_id`
- `timestamp_ms`
- `frame_index`
- `x`
- `y`
- `confidence`
- `observation_status`
- `court_x`
- `court_y`

### `shot_events`

- `id`
- `analysis_run_id`
- `rally_id`
- `player_track_id`
- `timestamp_ms`
- `shot_type`
- `classification_confidence`
- `landing_x`
- `landing_y`
- `outcome`
- `review_status`

### `court_calibrations`

- `id`
- `analysis_run_id`
- `calibration_data`
- `confidence`
- `created_at`

### `match_metrics`

- `id`
- `analysis_run_id`
- `metric_name`
- `metric_value`
- `unit`
- `confidence`
- `metric_version`

### `coaching_reports`

- `id`
- `analysis_run_id`
- `report_data`
- `coaching_model_version`
- `created_at`

### `user_corrections`

- `id`
- `analysis_run_id`
- `entity_type`
- `entity_id`
- `correction_data`
- `created_at`

Add appropriate indexes for match identifiers, analysis versions, timestamps, and event types.

For large tracking datasets, benchmark normalized tables against compressed chunked artifacts. Keep queryable metadata in PostgreSQL and use versioned files for large arrays if that is more efficient.

---

## 15. API Requirements

Use REST endpoints initially.

### Matches

- `POST /api/matches` — create a match and upload or register its source asset.
- `GET /api/matches` — list matches with pagination and filters.
- `GET /api/matches/{match_id}` — retrieve match metadata.
- `DELETE /api/matches/{match_id}` — explicitly delete the match and associated assets.

For large files, support upload sessions or direct-to-storage uploads rather than buffering entire files in memory.

### Analysis

- `POST /api/matches/{match_id}/analyses` — start a new analysis run.
- `GET /api/analyses/{analysis_id}` — retrieve status and configuration.
- `POST /api/analyses/{analysis_id}/retry` — retry a recoverable failed run.
- `GET /api/analyses/{analysis_id}/tracks` — retrieve player tracks.
- `GET /api/analyses/{analysis_id}/poses` — retrieve pose data for a time range.
- `GET /api/analyses/{analysis_id}/shuttle` — retrieve shuttle observations for a time range.
- `GET /api/analyses/{analysis_id}/events` — retrieve the event timeline.
- `GET /api/analyses/{analysis_id}/metrics` — retrieve calculated metrics.
- `GET /api/analyses/{analysis_id}/report` — retrieve the stored coaching report.

### Corrections and exports

- `PATCH /api/events/{event_id}` — correct an event.
- `POST /api/analyses/{analysis_id}/corrections` — save a tracking or analysis correction.
- `POST /api/matches/{match_id}/exports` — request an annotated video or report export.
- `GET /api/exports/{export_id}` — retrieve export status and a temporary authorized download URL.

Use pagination or timestamp windows for large result sets. Do not return every pose or shuttle observation in a single response.

Protect video and export URLs with authorization. Never expose raw storage paths.

---

## 16. User Interface Pages

### 16.1 Dashboard

Display:

- Recent matches.
- Processing jobs.
- Historical trends.
- Current training priorities.
- Failed jobs requiring attention.

### 16.2 Match library

Support:

- Search and filtering.
- Match date and duration.
- Processing status.
- Tags and notes.
- Reopening completed analysis.
- Explicit deletion.

### 16.3 Upload page

Provide:

- File selection.
- File validation.
- Upload progress.
- Processing progress.
- Clear error messages.
- Navigation away from the page without cancelling background processing.

### 16.4 Match analysis page

Include:

- Video player.
- Timeline and event markers.
- Skeleton overlay.
- Shuttle marker and trail.
- Player selection.
- Playback-speed control.
- Frame stepping.
- Court visualization.
- Shot event list.
- Coaching feedback.

### 16.5 Historical analytics page

Include:

- Match comparison.
- Movement heatmaps.
- Recovery-time trends.
- Shot distribution.
- Recurring weakness reports.
- Drill recommendations.

### 16.6 Settings

Include:

- Video-storage configuration.
- Processing settings.
- Overlay preferences.
- Privacy and deletion controls.
- Model and analysis-version information.
- Backup status where available.

---

## 17. Reliability and Error Handling

The application must distinguish upload failures, processing failures, missing assets, and optional-feature failures.

Requirements:

- Jobs survive browser closure and application restarts.
- Retries must not create duplicate matches or corrupt completed artifacts.
- Analysis runs are immutable after completion, except for explicitly versioned corrections.
- Reprocessing creates a new analysis version.
- The original video is never overwritten by an annotated export.
- A failed shuttle tracker does not invalidate a successful pose analysis.
- Missing data must not be represented as zero.
- All long-running jobs expose meaningful progress and status.
- Interrupted workers must be recoverable.
- File checksums and metadata should be verified where appropriate.

---

## 18. Security and Privacy

Although initially personal, the application must:

- Require authentication for private match data.
- Validate uploads and limit file sizes.
- Prevent path traversal and unsafe file access.
- Restrict access to stored video and export assets.
- Keep credentials and secrets in environment variables.
- Avoid logging sensitive video contents.
- Avoid executing uploaded files.
- Protect against unauthorized deletion.
- Provide explicit deletion and backup-retention policies.
- Use HTTPS when accessed over a network.
- Keep any optional cloud AI integration disabled unless configured by the user.

Do not transmit uploaded videos to external AI services without an explicit, documented configuration.

---

## 19. Testing Strategy

### Unit tests

Test:

- Timestamp conversion.
- Coordinate transformations.
- Court mapping.
- Speed calculations.
- Metric calculations.
- Confidence handling.
- Event correction.
- Analysis versioning.

### Integration tests

Test:

- Upload and durable storage.
- Job creation and recovery.
- Database persistence.
- Asset retrieval.
- Video replay after application restart.
- Analysis retry.
- Partial pipeline failure.
- Deletion behavior.
- Export generation.

### Computer-vision evaluation

Maintain a manually reviewed set of representative badminton videos.

Evaluate:

- Player detection accuracy.
- Track continuity and identity switches.
- Pose landmark accuracy.
- Shuttle detection precision and recall.
- Shuttle trajectory continuity.
- Court-calibration error.
- Shot-event timing error.
- Shot classification accuracy.
- Accuracy of derived movement metrics.

Compare predictions against manually annotated examples. Record results by camera angle, lighting, and video quality.

### Playback acceptance tests

1. Upload a video.
2. Wait for processing to complete.
3. Close the application.
4. Restart the application.
5. Reopen the match.
6. Confirm the original video plays.
7. Confirm overlays and event timestamps still work.
8. Seek to an event and inspect the correct frame.
9. Confirm reopening the match does not launch another analysis run.

---

## 20. Phased Development Plan

### Phase 1 — Persistent video library

Implement:

- Application foundation.
- Database and migrations.
- Video upload.
- Persistent asset storage.
- Match library.
- Video playback.
- Background-job infrastructure.
- Processing status and retry behavior.

**Acceptance criterion:** A video remains playable after application restart and can be reopened without re-uploading.

### Phase 2 — Player detection and skeleton

Implement:

- Player detection.
- Track identifiers.
- Manual player selection.
- Pose estimation.
- Green skeleton overlay.
- Timestamp synchronization.

**Acceptance criterion:** The selected player's skeleton can be reviewed throughout a representative recording, with uncertain frames identified.

### Phase 3 — Court mapping and movement

Implement:

- Court calibration.
- Player foot-position mapping.
- Movement trails.
- Heatmaps.
- Basic movement metrics.

**Acceptance criterion:** Movement can be visualized on a court diagram, and uncalibrated or low-confidence data is clearly identified.

### Phase 4 — Shuttle tracking

Implement:

- Shuttle detector evaluation.
- Timestamped shuttle observations.
- Trajectory association.
- Marker and trail overlays.
- Missing-observation handling.
- Tracking-confidence display.

**Acceptance criterion:** The application can display tracked shuttle observations on a manually reviewed test set and distinguish missing or uncertain observations from real detections.

### Phase 5 — Shot events

Implement:

- Rally segmentation.
- Candidate contact detection.
- Shot classification.
- Event timeline.
- Manual correction.

**Acceptance criterion:** The user can navigate from an event to its video timestamp and correct incorrect event labels.

### Phase 6 — Coaching and historical analysis

Implement:

- Movement and shot metrics.
- Evidence-grounded recommendations.
- Match comparisons.
- Recurring weakness identification.
- Drill recommendations.

**Acceptance criterion:** Every coaching recommendation references stored evidence or clearly states its uncertainty.

### Phase 7 — Advanced analysis

Investigate:

- More reliable shuttle trajectories.
- Approximate physical speed estimation.
- Improved shot classification.
- Expert-footage comparisons.
- Advanced tactical inference.
- Optional reference-player analysis.

These features must be validated individually before being presented as reliable.

---

## 21. Definition of Done

The first useful release is complete when the user can:

1. Upload a badminton video.
2. Find it later in a persistent library.
3. Replay it after application restarts.
4. View the selected player's green skeleton.
5. Inspect player movement on a court diagram.
6. View shuttle highlighting when tracking is available.
7. Navigate to timestamped events.
8. Review stored analysis without running the models again.
9. See initial movement metrics and evidence-based coaching feedback.
10. Compare at least two completed matches.
11. Correct analysis errors and preserve those corrections.
12. Recover from a failed optional analysis stage without losing the original video or successful results.

---

## 22. Instructions for Kiro

Use this specification as the source of truth.

Before implementation:

1. Inspect the existing repository and development environment.
2. Produce a requirements document and implementation design.
3. Identify suitable pretrained models and confirm licensing and hardware requirements.
4. Design the database schema and asset-storage strategy.
5. Define API contracts and processing-job states.
6. Create a phased task list with explicit acceptance criteria.
7. Identify technical risks and run small feasibility experiments before building advanced features.

Implementation rules:

- Do not implement the entire application in one step.
- Preserve working functionality.
- Avoid unrelated refactoring.
- Add tests for each implemented stage.
- Use migrations for database changes.
- Keep model-specific logic behind replaceable interfaces.
- Keep large video-processing tasks outside the API request lifecycle.
- Store all timestamps and coordinate systems consistently.
- Never fabricate detections, measurements, or coaching evidence.
- Report which features are fully implemented, partially implemented, experimental, or not implemented.
- Do not mark a milestone complete until its acceptance criteria pass.

Start with Phase 1. Do not begin advanced shuttle-speed estimation until the video pipeline, timestamps, and persistent analysis storage are working correctly.
