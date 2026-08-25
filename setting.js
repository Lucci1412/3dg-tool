// ============================================================
// 3DG Topology Checker — Global Settings Configuration File
// - Stores default values for topology scan tolerance, zoom levels, and colors
// ============================================================

window.__topoConfig = {
    // Topo Engine Settings
    defaultTolerance: 0.001,       // Default dangle tolerance in meters
    minTolerance: 0.001,           // Minimum slider tolerance
    maxTolerance: 5.0,           // Maximum slider tolerance
    toleranceStep: 0.1,          // Slider step size

    // Navigation & Zoom
    defaultZoom: 21,             // Hardcoded close-up zoom level for error navigation

    // Visual Styles
    highlightColor: '#0284c7',   // Neon blue highlight color for selected lines
    highlightWidth: 6,           // Highlight stroke width
    activeMarkerColor: '#ff0044',// Selected error halo marker color
    dangleMarkerColor: '#ff1100' // Open endpoint red bulb marker color
};
