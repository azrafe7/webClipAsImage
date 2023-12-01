"use strict";

(async () => {
  
  const DEBUG = false;
  let debug = {
    log: DEBUG ? console.log.bind(console) : () => {} // log or NO_OP
  }

  let manifest = chrome.runtime.getManifest();
  console.log(manifest.name + " v" + manifest.version);

  const HIGHLIGHT_RED = "rgba(250, 70, 60, 0.5)";
  const HIGHLIGHT_GREEN = "rgba(17, 193, 12, 0.5)";
  const HIGHLIGHT_BG_COLOR = HIGHLIGHT_GREEN;

  const OUTLINE_RED = "rgba(250, 70, 60, 0.75)";
  const OUTLINE_GREEN = "rgba(17, 193, 12, 0.90)";
  const OUTLINE_COLOR = OUTLINE_GREEN;

  const CURSORS = ["crosshair", "copy"];

  let lastTriggeredElement = null;

  /* if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    // dark mode
    HIGHLIGHT_BG_COLOR = HIGHLIGHT_DARK;
    OUTLINE_COLOR = OUTLINE_DARK;
  } */

  let options = {
    container: null,
    iFrameId: 'WebClip Element Picker Frame',
    enabled: false,
    selectors: "*",
    background: HIGHLIGHT_BG_COLOR,
    borderWidth: 0,
    outlineWidth: 1,
    outlineColor: OUTLINE_COLOR,
    transition: "",
    ignoreElements: [],
    action: {},
    hoverBoxInfoId: 'webclip_picker_info',
  }

  // create "disabled" elementPicker on page load
  let elementPicker = new ElementPicker(options);

  // elementPicker.hoverBox.style.cursor = CURSORS[0];
  elementPicker.action = {
    trigger: "mouseup",
    
    callback: ((event, target) => {
      debug.log("[WebClipElement:CTX] event:", event);
      let continuePicking = event.shiftKey;
      event.triggered = event.triggered ?? event.button == 0; // only proceed if left mouse button was pressed or "event.triggered" was set
      if (event.triggered) {
        debug.log("[WebClipElement:CTX] target:", target);
        debug.log("[WebClipElement:CTX] info:", elementPicker.hoverInfo);
        lastTriggeredElement = elementPicker.hoverInfo.element;
        elementPicker.hoverInfo.element = null; // not serializable
        const hoverInfoClone = structuredClone(elementPicker.hoverInfo);
        setTimeout(() => { // to ensure picker overlay is removed
          chrome.runtime.sendMessage(
            {
              event: "takeScreenshot",
              data: {hoverInfo: hoverInfoClone, continuePicking: continuePicking},
            },
          );
        }, 50);
      }
      
      elementPicker.enabled = false; // always disable picker highlight (so that it's not saved in the screenshot)
    })
  }

  function getVisibleRect(rect) {
    let visibleRect = DOMRect.fromRect(rect);

    if (visibleRect.x < 0) {
      visibleRect.width += visibleRect.x;
      visibleRect.x = 0;
    }
    if (visibleRect.y < 0) {
      visibleRect.height += visibleRect.y;
      visibleRect.y = 0;
    }
    if (visibleRect.x + visibleRect.width > window.innerWidth) {
      visibleRect.width = window.innerWidth - visibleRect.x;
    }
    if (visibleRect.y + visibleRect.height > window.innerHeight) {
      visibleRect.height = window.innerHeight - visibleRect.y;
    }
    return visibleRect;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    debug.log("[WebClipElement:CTX]", msg);
    const { event, data } = msg;

    if (event === "enablePicker") {
      elementPicker.enabled = data?.enable ?? true;
      elementPicker.hoverBox.style.cursor = CURSORS[0];
    } else if (event === "takenScreenshot") {
      let dataURL = data.dataURL;
      let hoverInfo = data.hoverInfo;
      let continuePicking = data?.continuePicking;
      
      if (continuePicking) {
        elementPicker.enabled = true;
        elementPicker.highlight(lastTriggeredElement);
      }
      
      let image = new Image();
      image.onload = () => {
        let rect = {x: hoverInfo.left, y: hoverInfo.top, width: hoverInfo.width, height: hoverInfo.height};
        let visibleRect = getVisibleRect(rect); //getVisibleRect(hoverInfo.clientRect);
        debug.log("[WebClipElement:CTX] cropping...", visibleRect);
        let canvas = document.createElement('canvas');
        let ctx = canvas.getContext('2d');

        const zoomLevel = window.devicePixelRatio;
        if (zoomLevel != 1.0) {
          visibleRect.x *= zoomLevel;
          visibleRect.y *= zoomLevel;
          visibleRect.width *= zoomLevel;
          visibleRect.height *= zoomLevel;
        }
        canvas.width = visibleRect.width;
        canvas.height = visibleRect.height;
        
        ctx.drawImage(image, visibleRect.x, visibleRect.y, visibleRect.width, visibleRect.height,
                             0, 0, visibleRect.width, visibleRect.height);
        
        ((croppedDataURL) => {
          canvas = null;
          ctx = null;
          debug.log("[WebClipElement:CTX] send cropped dataURL", croppedDataURL);
          chrome.runtime.sendMessage(
            {
              event: "openCroppedInNewTab",
              data: {
                dataURL: croppedDataURL,
                continuePicking: continuePicking,
              },
            },
          );
        })(canvas.toDataURL());
      };
      image.src = dataURL;
    }
  });

  const keyEventContainer = window; // elementPicker.iframe ? elementPicker.iframe : window;

  // close picker when pressing ESC
  keyEventContainer.addEventListener('keyup', function(e) {
    if (e.code === 'Escape' && elementPicker.enabled) {
      elementPicker.enabled = false;
      debug.log("[WebClipElement:CTX] user aborted");
    }
  }, true);

  keyEventContainer.addEventListener('keydown', function(e) {
    let target = null;
    let newTarget = null;
    if (e.code === 'Space' && elementPicker.enabled) {
      target = elementPicker.hoverInfo.element;
      debug.log("[WebClipElement:CTX] space-clicked target:", target);
      e.preventDefault();
      e.triggered = true; // checked inside action callback
      elementPicker.trigger(e);
    } else if (elementPicker.enabled && (e.code === 'KeyQ' || e.code === 'KeyA')) {
      target = elementPicker.hoverInfo.element;

      let innermostTargetAtPoint = null; // first non-picker-iframe element
      for (let el of document.elementsFromPoint(elementPicker._lastClientX, elementPicker._lastClientY)) {
        if (el != elementPicker.iframe) {
          innermostTargetAtPoint = el;
          break;
        }
      }
      // build ancestors array
      let ancestorsAndSelf = [];
      for (let el=innermostTargetAtPoint; el != null; el = el.parentElement) {
        ancestorsAndSelf.push(el);
      }
      
      const ancestorsAndSelfLength = ancestorsAndSelf.length;
      const targetIdx = ancestorsAndSelf.indexOf(target);
      const targetHasNext = targetIdx <= (ancestorsAndSelfLength - 2);
      const targetHasPrev = targetIdx > 0;
      if (e.code === 'KeyQ' && targetHasNext) { // drill up
        newTarget = ancestorsAndSelf[targetIdx + 1];
        if (newTarget.contains(elementPicker.iframe)) {
          newTarget = target;
        }
        debug.log("[WebClipElement:CTX] Q-pressed new ↑ target:", newTarget);
      } else if (e.code === 'KeyA' && targetHasPrev) { // drill down
        newTarget = ancestorsAndSelf[targetIdx - 1];
        if (newTarget.contains(elementPicker.iframe)) {
          newTarget = target;
        }
        debug.log("[WebClipElement:CTX] A-pressed new ↓ target:", newTarget);
      }
      debug.log(`${targetIdx}/${ancestorsAndSelfLength}`, 'newTarget', targetHasPrev, targetHasNext, newTarget);
      if (newTarget && newTarget != target) {
        elementPicker.highlight(newTarget);
      }
      e.preventDefault();
    }
  }, true);

  // change picker cursor when holding SHIFT
  function updateCursor(eventInfo) {
    let {keyUp, event} = eventInfo;
    if (elementPicker.enabled) {
      let cursorIdx = +event.shiftKey;
      if (elementPicker.hoverBox.style.cursor != CURSORS[cursorIdx]) {
        debug.log('[WebClipElement:CTX] change cursor to ' + CURSORS[cursorIdx]);
        elementPicker.hoverBox.style.cursor = CURSORS[cursorIdx];
      }
    }
  }
  
  keyEventContainer.addEventListener('keyup', (e) => updateCursor({keyUp: true, event: e}), true);
  keyEventContainer.addEventListener('keydown', (e) => updateCursor({keyUp: false, event: e}), true);

})();
