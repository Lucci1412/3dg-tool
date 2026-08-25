// Content script: Loader cho 3DG Topology Checker Extension
// Inject CSS và JavaScript các Module vào MAIN world context của trang 3dg.vn

// Lưu Extension Base URL qua DOM data attribute (Tuân thủ CSP 100%, không bị lỗi inline script)
document.documentElement.setAttribute('data-topo-extension-base-url', chrome.runtime.getURL(''));

const scripts = [
    'setting.js',
    'core/map-bridge.js',
    'core/2d/check-topo.js',
    'core/2d/area-delete.js',
    'core/2d/area-color.js',
    'core/2d/smart-draw.js',
    'core/2d/cut-line.js',
    'core/3d/bridge-3d.js',
    'core/3d/check-topo.js',
    'core/3d/area-color.js',
    'core/topo-ui.js'
];

// Inject CSS stylesheet
const styleLink = document.createElement('link');
styleLink.rel = 'stylesheet';
styleLink.href = chrome.runtime.getURL('styles.css');
(document.head || document.documentElement).appendChild(styleLink);

function injectNext(index) {
    if (index >= scripts.length) {
        return;
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(scripts[index]);
    script.onload = function () {
        this.remove();
        injectNext(index + 1);
    };
    script.onerror = function (err) {
        console.error('[TopologyChecker] ❌ FAILED to load Module:', scripts[index], err);
        this.remove();
        injectNext(index + 1);
    };
    (document.head || document.documentElement).appendChild(script);
}

injectNext(0);
