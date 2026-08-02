//! Focus-scoped macOS Accessibility (AXUIElement) support.
//! Traversal is deliberately bounded and mutations are allowlisted.

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::ptr;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::{CFBoolean, CFBooleanGetTypeID};
use core_foundation::string::{CFString, CFStringGetTypeID, CFStringRef};
use napi::{Error, Result, Status};

use crate::types::{AccessibilityElement, AccessibilityOptions, Region};

type AXUIElementRef = *const c_void;
type AXValueRef = *const c_void;
type AXError = i32;

const AX_OK: AXError = 0;
const AX_VALUE_CGPOINT: i32 = 1;
const AX_VALUE_CGSIZE: i32 = 2;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut bool,
    ) -> AXError;
    fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXValueGetType(value: AXValueRef) -> i32;
    fn AXValueGetValue(value: AXValueRef, value_type: i32, value_ptr: *mut c_void) -> bool;
    fn AXValueGetTypeID() -> CFTypeID;
}

struct AxOwned(AXUIElementRef);
impl Drop for AxOwned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}

pub fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

fn ax_error(context: &str, code: AXError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{context} failed with AXError {code}"),
    )
}

fn copy_attr(element: AXUIElementRef, name: &str) -> Option<CFTypeRef> {
    let key = CFString::new(name);
    let mut value: CFTypeRef = ptr::null();
    let result =
        unsafe { AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value) };
    if result == AX_OK && !value.is_null() {
        Some(value)
    } else {
        None
    }
}

fn copy_element_attr(element: AXUIElementRef, name: &str) -> Option<AxOwned> {
    copy_attr(element, name).map(|v| AxOwned(v as AXUIElementRef))
}

fn string_attr(element: AXUIElementRef, name: &str) -> Option<String> {
    let value = copy_attr(element, name)?;
    let result = unsafe {
        if CFGetTypeID(value) == CFStringGetTypeID() {
            Some(CFString::wrap_under_get_rule(value as CFStringRef).to_string())
        } else {
            None
        }
    };
    unsafe { CFRelease(value) };
    result
}

fn bool_attr(element: AXUIElementRef, name: &str) -> Option<bool> {
    let value = copy_attr(element, name)?;
    let result = unsafe {
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            Some(CFBoolean::wrap_under_get_rule(value as _).into())
        } else {
            None
        }
    };
    unsafe { CFRelease(value) };
    result
}

fn value_as_string(element: AXUIElementRef) -> Option<String> {
    let value = copy_attr(element, "AXValue")?;
    let result = unsafe {
        if CFGetTypeID(value) == CFStringGetTypeID() {
            Some(CFString::wrap_under_get_rule(value as CFStringRef).to_string())
        } else if CFGetTypeID(value) == CFBooleanGetTypeID() {
            let b: bool = CFBoolean::wrap_under_get_rule(value as _).into();
            Some(b.to_string())
        } else {
            None
        }
    };
    unsafe { CFRelease(value) };
    result
}

fn point_attr(element: AXUIElementRef, name: &str, kind: i32) -> Option<(f64, f64)> {
    let value = copy_attr(element, name)?;
    let mut pair = CGPoint::default();
    let valid = unsafe {
        CFGetTypeID(value) == AXValueGetTypeID()
            && AXValueGetType(value as AXValueRef) == kind
            && AXValueGetValue(
                value as AXValueRef,
                kind,
                &mut pair as *mut _ as *mut c_void,
            )
    };
    unsafe { CFRelease(value) };
    if valid {
        Some((pair.x, pair.y))
    } else {
        None
    }
}

fn bounds(element: AXUIElementRef) -> Option<Region> {
    let (x, y) = point_attr(element, "AXPosition", AX_VALUE_CGPOINT)?;
    // CGPoint and CGSize are both two f64 values, so point_attr can marshal either.
    let (width, height) = point_attr(element, "AXSize", AX_VALUE_CGSIZE)?;
    Some(Region {
        x,
        y,
        width,
        height,
    })
}

fn actions(element: AXUIElementRef) -> Vec<String> {
    let mut raw: CFArrayRef = ptr::null();
    let status = unsafe { AXUIElementCopyActionNames(element, &mut raw) };
    if status != AX_OK || raw.is_null() {
        return vec![];
    }
    let array = unsafe { CFArray::<CFString>::wrap_under_create_rule(raw) };
    (0..array.len())
        .filter_map(|i| array.get(i).map(|item| item.to_string()))
        .collect()
}

fn children(element: AXUIElementRef) -> Vec<AxOwned> {
    let Some(value) = copy_attr(element, "AXChildren") else {
        return vec![];
    };
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_create_rule(value as CFArrayRef) };
    (0..array.len())
        .filter_map(|i| {
            let child = *array.get(i)? as AXUIElementRef;
            if child.is_null() {
                None
            } else {
                unsafe {
                    core_foundation::base::CFRetain(child as CFTypeRef);
                }
                Some(AxOwned(child))
            }
        })
        .collect()
}

fn focused_window() -> Result<AxOwned> {
    if !trusted() {
        return Err(Error::new(
            Status::GenericFailure,
            "macOS Accessibility permission is not granted",
        ));
    }
    let system = AxOwned(unsafe { AXUIElementCreateSystemWide() });
    let app = copy_element_attr(system.0, "AXFocusedApplication").ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "No focused accessibility application",
        )
    })?;
    copy_element_attr(app.0, "AXFocusedWindow")
        .ok_or_else(|| Error::new(Status::GenericFailure, "No focused accessibility window"))
}

fn is_interactive(role: &str, action_names: &[String]) -> bool {
    matches!(
        role,
        "AXButton"
            | "AXCheckBox"
            | "AXRadioButton"
            | "AXTextField"
            | "AXTextArea"
            | "AXComboBox"
            | "AXPopUpButton"
            | "AXMenuButton"
            | "AXSlider"
            | "AXIncrementor"
            | "AXLink"
            | "AXDateField"
    ) || action_names
        .iter()
        .any(|a| a == "AXPress" || a == "AXConfirm")
}

fn visit(
    element: AXUIElementRef,
    id: String,
    depth: u32,
    options: &AccessibilityOptions,
    output: &mut Vec<AccessibilityElement>,
) {
    if output.len() >= options.max_elements.unwrap_or(500) as usize {
        return;
    }
    let role = string_attr(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let action_names = actions(element);
    let kids = children(element);
    if !options.interactive_only.unwrap_or(true) || is_interactive(&role, &action_names) {
        output.push(AccessibilityElement {
            id: id.clone(),
            role,
            subrole: string_attr(element, "AXSubrole"),
            title: string_attr(element, "AXTitle"),
            description: string_attr(element, "AXDescription"),
            value: value_as_string(element),
            enabled: bool_attr(element, "AXEnabled"),
            focused: bool_attr(element, "AXFocused"),
            bounds: bounds(element),
            actions: action_names,
            child_count: kids.len() as u32,
        });
    }
    if depth >= options.max_depth.unwrap_or(12) {
        return;
    }
    for (index, child) in kids.iter().enumerate() {
        visit(child.0, format!("{id}.{index}"), depth + 1, options, output);
        if output.len() >= options.max_elements.unwrap_or(500) as usize {
            break;
        }
    }
}

pub fn elements(options: Option<AccessibilityOptions>) -> Result<Vec<AccessibilityElement>> {
    let root = focused_window()?;
    let options = options.unwrap_or(AccessibilityOptions {
        max_depth: Some(12),
        max_elements: Some(500),
        interactive_only: Some(true),
    });
    let mut output = Vec::new();
    visit(root.0, "root".into(), 0, &options, &mut output);
    Ok(output)
}

fn element_at_path(path: &str) -> Result<AxOwned> {
    let mut current = focused_window()?;
    if path == "root" {
        return Ok(current);
    }
    let suffix = path
        .strip_prefix("root.")
        .ok_or_else(|| Error::new(Status::InvalidArg, "Accessibility id must begin with root"))?;
    for part in suffix.split('.') {
        let index: usize = part.parse().map_err(|_| {
            Error::new(
                Status::InvalidArg,
                format!("Invalid accessibility id: {path}"),
            )
        })?;
        let kids = children(current.0);
        if index >= kids.len() {
            return Err(Error::new(
                Status::InvalidArg,
                "Accessibility element is stale; inspect the focused window again",
            ));
        }
        current = AxOwned(unsafe {
            core_foundation::base::CFRetain(kids[index].0 as CFTypeRef) as AXUIElementRef
        });
    }
    Ok(current)
}

pub fn set_value(id: &str, value: &str) -> Result<()> {
    let element = element_at_path(id)?;
    let attribute = CFString::new("AXValue");
    let mut settable = false;
    let status = unsafe {
        AXUIElementIsAttributeSettable(element.0, attribute.as_concrete_TypeRef(), &mut settable)
    };
    if status != AX_OK {
        return Err(ax_error("Checking AXValue", status));
    }
    if !settable {
        return Err(Error::new(
            Status::InvalidArg,
            "AXValue is not settable for this element",
        ));
    }
    let new_value = CFString::new(value);
    let status = unsafe {
        AXUIElementSetAttributeValue(
            element.0,
            attribute.as_concrete_TypeRef(),
            new_value.as_CFTypeRef(),
        )
    };
    if status == AX_OK {
        Ok(())
    } else {
        Err(ax_error("Setting AXValue", status))
    }
}

pub fn perform_action(id: &str, action: &str) -> Result<()> {
    const ALLOWED: &[&str] = &[
        "AXPress",
        "AXConfirm",
        "AXCancel",
        "AXShowMenu",
        "AXIncrement",
        "AXDecrement",
        "AXPick",
    ];
    if !ALLOWED.contains(&action) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Accessibility action is not allowlisted: {action}"),
        ));
    }
    let element = element_at_path(id)?;
    if !actions(element.0)
        .iter()
        .any(|candidate| candidate == action)
    {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Element does not expose accessibility action {action}"),
        ));
    }
    let action_name = CFString::new(action);
    let status = unsafe { AXUIElementPerformAction(element.0, action_name.as_concrete_TypeRef()) };
    if status == AX_OK {
        Ok(())
    } else {
        Err(ax_error("Performing action", status))
    }
}
