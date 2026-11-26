use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path, sync::Mutex};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

#[derive(Clone, Copy, Deserialize, Serialize)]
struct SavedWindow {
    width: u32,
    height: u32,
    position: Option<PhysicalPosition<i32>>,
    maximized: bool,
}

impl SavedWindow {
    fn valid_size(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

#[derive(Clone, Copy)]
struct WorkArea {
    origin: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

impl WorkArea {
    fn contains(&self, position: PhysicalPosition<i32>) -> bool {
        let x = i64::from(position.x) - i64::from(self.origin.x);
        let y = i64::from(position.y) - i64::from(self.origin.y);
        (0..i64::from(self.size.width)).contains(&x)
            && (0..i64::from(self.size.height)).contains(&y)
    }

    fn fit(&self, saved: SavedWindow) -> SavedWindow {
        let width = saved.width.min(self.size.width);
        let height = saved.height.min(self.size.height);
        let fit_axis = |value: i32, origin: i32, remaining: u32| {
            let end = i64::from(origin) + i64::from(remaining);
            i64::from(value).clamp(i64::from(origin), end) as i32
        };
        let position = saved.position.map(|position| {
            let position = if self.contains(position) {
                position
            } else {
                PhysicalPosition::new(
                    self.origin
                        .x
                        .saturating_add(((self.size.width - width) / 2) as i32),
                    self.origin
                        .y
                        .saturating_add(((self.size.height - height) / 2) as i32),
                )
            };
            PhysicalPosition::new(
                fit_axis(position.x, self.origin.x, self.size.width - width),
                fit_axis(position.y, self.origin.y, self.size.height - height),
            )
        });
        SavedWindow {
            width,
            height,
            position,
            ..saved
        }
    }
}

fn restore(window: &WebviewWindow, saved: SavedWindow) -> Option<SavedWindow> {
    if !saved.valid_size() {
        return None;
    }
    let work_area = |monitor: tauri::Monitor| {
        let area = monitor.work_area();
        (area.size.width > 0 && area.size.height > 0).then_some(WorkArea {
            origin: area.position,
            size: area.size,
        })
    };
    let areas: Vec<_> = window
        .available_monitors()
        .ok()?
        .into_iter()
        .filter_map(work_area)
        .collect();
    let area = saved
        .position
        .and_then(|position| areas.iter().copied().find(|area| area.contains(position)))
        .or_else(|| window.primary_monitor().ok().flatten().and_then(work_area))
        .or_else(|| areas.first().copied())?;

    // Keep native window decorations within the monitor's usable bounds.
    let mut area = area;
    if let (Ok(outer), Ok(inner)) = (window.outer_size(), window.inner_size()) {
        area.size.width = area
            .size
            .width
            .saturating_sub(outer.width.saturating_sub(inner.width))
            .max(1);
        area.size.height = area
            .size
            .height
            .saturating_sub(outer.height.saturating_sub(inner.height))
            .max(1);
    }
    let bounds = area.fit(saved);
    let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
    if let Some(position) = bounds.position {
        let _ = window.set_position(position);
    }
    if saved.maximized {
        let _ = window.maximize();
    }
    Some(bounds)
}

fn capture(window: &WebviewWindow, previous: Option<SavedWindow>) -> Option<SavedWindow> {
    if window.is_minimized().ok()? || window.is_fullscreen().ok()? {
        return previous;
    }
    if window.is_maximized().ok()? {
        return previous.map(|saved| SavedWindow {
            maximized: true,
            ..saved
        });
    }
    let size = window.inner_size().ok()?;
    let saved = SavedWindow {
        width: size.width,
        height: size.height,
        position: window.outer_position().ok(),
        maximized: false,
    };
    if saved.valid_size() {
        Some(saved)
    } else {
        previous
    }
}

fn save(path: &Path, state: SavedWindow) -> io::Result<()> {
    let directory = path.parent().expect("window state path has a parent");
    fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(temporary.as_file_mut(), &state)?;
    temporary.persist(path)?;
    Ok(())
}

pub fn attach(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(directory) = app.path().app_config_dir() else {
        return;
    };
    let path = directory.join("window-state.json");
    let original = capture(&window, None);
    let restored = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .and_then(|saved| restore(&window, saved));
    let state = Mutex::new(restored.or(original));
    let tracked_window = window.clone();
    window.on_window_event(move |event| {
        let Ok(mut state) = state.lock() else { return };
        match event {
            WindowEvent::Moved(_)
            | WindowEvent::Resized(_)
            | WindowEvent::CloseRequested { .. } => {
                *state = capture(&tracked_window, *state).or(*state);
            }
            // Destroyed follows the frontend's existing save-or-discard close flow.
            WindowEvent::Destroyed => {
                if let Some(saved) = *state
                    && let Err(error) = save(&path, saved)
                {
                    eprintln!("Could not save window state: {error}");
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_oversize_and_offscreen_bounds_to_available_work_area() {
        let area = WorkArea {
            origin: PhysicalPosition::new(-1400, 24),
            size: PhysicalSize::new(1400, 900),
        };
        let saved = SavedWindow {
            width: u32::MAX,
            height: 600,
            position: Some(PhysicalPosition::new(i32::MAX, i32::MIN)),
            maximized: true,
        };
        let fitted = area.fit(saved);
        assert_eq!((fitted.width, fitted.height), (1400, 600));
        assert_eq!(fitted.position, Some(PhysicalPosition::new(-1400, 174)));
        assert!(fitted.maximized);
        let fitted = area.fit(SavedWindow {
            width: 800,
            position: Some(PhysicalPosition::new(-300, 700)),
            ..saved
        });
        assert_eq!(fitted.position, Some(PhysicalPosition::new(-800, 324)));
    }

    #[test]
    fn stores_normal_bounds_and_maximized_state_and_rejects_zero_size() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config").join("window-state.json");
        let saved = SavedWindow {
            width: 800,
            height: 600,
            position: None,
            maximized: true,
        };
        save(&path, saved).unwrap();
        let restored: SavedWindow = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!((restored.width, restored.height), (800, 600));
        assert!(restored.maximized);
        assert!(restored.position.is_none());
        assert!(
            !SavedWindow {
                width: 0,
                ..restored
            }
            .valid_size()
        );
    }
}
