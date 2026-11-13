# GraceDesk Changelog

## v1.0.68

### Highlights
- Added recovery for SQLite files confirmed to be malformed, while preserving databases when an open or lock error may be transient.
- Respects the device's reduced-motion preference unless a user has explicitly selected a performance-mode setting.
- Improved the teacher calendar's sticky period heading and date-range label.
- Refreshed GraceDesk branding and app icons across the portal.

### Bug fixes and stability improvements
- Avoids moving healthy portal data when SQLite reports an unavailable path or a temporary lock.
- Kept a backup of a malformed database before rebuilding portal state from the migration workbook.

---

## v1.0.66

### Highlights
- Added and refined the nutritional status views with BOSY and EOSY support.
- Improved the dashboard layout and page spacing for a cleaner, more readable experience.
- Made the tarpaulin controls section collapsible to maximize preview area.
- Improved the Teacher Profile tabs for stronger visibility without clutter.
- Added a new vibrant default theme option and integrated theme refinements.
- Removed the Inventory navigation item without disrupting the rest of the app.
- Improved school logo handling with a cleaner circular transparent preview while preserving the original upload.
- Updated the brand contact area with clearer support and feedback messaging.
- Renamed the Students navigation label to “Students' Roster”.
- Fixed a real UI performance issue affecting rapid input by reducing unnecessary re-renders and preserving responsiveness.
- Built and validated the app before publishing the new release.

### Bug fixes and stability improvements
- Reduced unnecessary re-rendering during rapid PHIL-IRI class search input.
- Preserved original uploaded school logos while generating a clean preview-only version.
- Kept the app layout consistent and stable while updating visual design elements.
- Updated the relevant validation checks to reflect the latest stable UI behavior.

### Release details
- Version: v1.0.66
- Published on GitHub: https://github.com/bloodheaddemogorgon-ops/avera-portal/releases/tag/v1.0.66
- Build artifacts included Windows installer packages and release metadata.

---

## User-facing announcement post

GraceDesk v1.0.66 is now live!

This update brings a cleaner portal layout, improved nutritional status tracking with BOSY and EOSY support, a more polished dashboard experience, and a refreshed visual theme. We also improved app responsiveness, refined the school logo preview, and added better support/contact messaging.

Thank you for your feedback and suggestions. We continue improving the app to make it more useful, stable, and easier to work with.

---

## Next update ideas for v1.0.69

1. Add more detailed teacher/student analytics widgets to the dashboard.
2. Improve report export options for printable summaries and teacher records.
3. Introduce a more compact mobile-friendly navigation mode.
4. Add a quick settings panel for theme, layout density, and display preferences.
5. Improve the logo upload workflow with optional crop and fit controls.
6. Add a lightweight activity log for recent updates and edits.
7. Expand nutrition status filters and reporting for BOSY/EOSY comparison views.
8. Improve onboarding for first-time users and new school profile setup.
9. Add toast notifications for successful uploads, saves, and system actions.
10. Review and improve accessibility for keyboard navigation and color contrast.

---

## Notes
This changelog is intended as a concise release summary for maintainers and end users. It captures the improvements shipped in v1.0.66 and creates a clear direction for the next iteration.
