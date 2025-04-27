// === bezier-editor.js ===
// Logic for Bezier curve editing mode

// IIFE to encapsulate Bezier logic
(function() {
    // Ensure main script elements and variables are available
    if (typeof canvas === 'undefined' || typeof ctx === 'undefined' || typeof waveformData === 'undefined' || typeof redraw === 'undefined' || typeof quantizeValue === 'undefined') {
        console.error("Bezier Editor Error: Required global variables/functions not found.");
        return;
    }
    // Also check for state variables from the main script that are needed
     if (typeof currentLength === 'undefined' || typeof currentMaxValue === 'undefined' ||
         typeof currentCenterValue === 'undefined' || typeof baseWidth === 'undefined' ||
         typeof baseHeight === 'undefined' || typeof dpr === 'undefined' ||
         typeof cellWidth === 'undefined' || typeof stepHeight === 'undefined' || typeof centerY === 'undefined') {
         console.error("Bezier Editor Error: Required global state variables not found.");
         return;
     }

    console.log("Bezier Editor Script Initializing...");

    // --- Bezier Data Structures ---
    let anchors = []; // Array of { x, y } anchor points
    let controls = []; // Array of { cp1x, cp1y, cp2x, cp2y } control points for segment STARTING at index i

    // --- State Variables ---
    let selectedPoint = { type: null, index: -1, handle: 0 }; // type: 'anchor', 'control'; handle: 1(cp1) or 2(cp2)
    window.isDraggingBezierPoint = false; // Expose drag state globally for main script's mouseup/touchend
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const pointSize = 8; // Visual size (width/height) of anchor squares
    const handleRadius = 4; // Visual size of control points
    const handleLineWidth = 1; // Pixel width for handles
    const hitThreshold = 12; // Click detection radius (larger for touch)

    // --- Bezier Math Utilities ---

    // De Casteljau's algorithm for splitting a Bezier segment at t
    function subdivideBezier(p0, p1, p2, p3, t) {
        const q0 = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
        const q1 = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
        const q2 = { x: p2.x + (p3.x - p2.x) * t, y: p2.y + (p3.y - p2.y) * t };
        const r0 = { x: q0.x + (q1.x - q0.x) * t, y: q0.y + (q1.y - q0.y) * t };
        const r1 = { x: q1.x + (q2.x - q1.x) * t, y: q1.y + (q2.y - q1.y) * t };
        const s0 = { x: r0.x + (r1.x - r0.x) * t, y: r0.y + (r1.y - r0.y) * t };
        // s0 is the point on the curve at t
        // First curve: p0, q0, r0, s0
        // Second curve: s0, r1, q2, p3
        return {
            first: { p0: p0, p1: q0, p2: r0, p3: s0 },
            second: { p0: s0, p1: r1, p2: q2, p3: p3 }
        };
    }

    // Get point on a cubic bezier curve at parameter t (0 <= t <= 1)
    function getBezierPoint(t, p0, p1, p2, p3) {
        const mt = 1 - t; const mt2 = mt * mt; const mt3 = mt2 * mt;
        const t2 = t * t; const t3 = t2 * t;
        const x = mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x;
        const y = mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y;
        return { x: x, y: y };
    }

     // Approximate Y value on a cubic bezier curve for a given X
     function findYatX(x, p0, p1, p2, p3, tolerance = 0.01) {
         let t_low = 0, t_high = 1, t_mid = 0.5;
         let x_mid, y_mid;
         const max_iterations = 100;

         // Handle edge cases where x is outside the segment's x-range
         const minX = Math.min(p0.x, p3.x);
         const maxX = Math.max(p0.x, p3.x);
          if (x <= minX + tolerance) return getBezierPoint(0, p0, p1, p2, p3).y;
          if (x >= maxX - tolerance) return getBezierPoint(1, p0, p1, p2, p3).y;


         for (let i = 0; i < max_iterations; i++) {
             const pt_mid = getBezierPoint(t_mid, p0, p1, p2, p3);
             x_mid = pt_mid.x;
             y_mid = pt_mid.y;

             if (Math.abs(x_mid - x) < tolerance) break; // Found sufficiently close t

             // Adjust search range based on monotonic X assumption (usually holds for typical curves)
             // A more robust method would check derivative or handle non-monotonic cases
              if (p3.x > p0.x) { // Generally increasing X
                  if (x_mid < x) { t_low = t_mid; } else { t_high = t_mid; }
              } else { // Generally decreasing X
                   if (x_mid > x) { t_low = t_mid; } else { t_high = t_mid; }
              }
             t_mid = (t_low + t_high) / 2;
         }
        // Return Y at the best t found
        return getBezierPoint(t_mid, p0, p1, p2, p3).y;
    }

    function distSq(p1, p2) { return Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2); }

    // Find closest point on a bezier segment to a given point p
    function findClosestPointOnSegment(p, p0, p1, p2, p3, steps = 30) { // Reduced steps slightly
        let closestT = 0; let minDistSq = distSq(p, p0); // Start with t=0 distance

        for (let i = 1; i <= steps; i++) {
            const t = i / steps; const pt = getBezierPoint(t, p0, p1, p2, p3); const dSq = distSq(p, pt);
            if (dSq < minDistSq) { minDistSq = dSq; closestT = t; }
        }
        return { t: closestT, distSq: minDistSq };
    }

    // --- Bezier Initialization (Exposed Globally) ---
    window.initializeBezier = function() {
        console.log("Initializing Bezier data");
         // Use current baseWidth/baseHeight from main script state
        const currentCenterY = baseHeight / 2;
        anchors = [ { x: 0, y: currentCenterY }, { x: baseWidth, y: currentCenterY } ];
        controls = [ { cp1x: baseWidth / 3, cp1y: currentCenterY, cp2x: baseWidth * 2 / 3, cp2y: currentCenterY } ];
        selectedPoint = { type: null, index: -1, handle: 0 };
        isDraggingBezierPoint = false;
        if (typeof generateWaveformFromBezier === 'function') { generateWaveformFromBezier(); }
    }

    // --- Drawing Functions (Exposed Globally) ---
    window.drawBezierEditor = function() {
        if (!anchors || anchors.length < 2) return;

        const scaledPointSize = pointSize / dpr;
        const scaledHandleRadius = handleRadius / dpr;
        const scaledHandleLineWidth = Math.max(1, handleLineWidth / dpr);

        const anchorColor = getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim();
        const controlColor = getComputedStyle(document.documentElement).getPropertyValue('--muted-text-color').trim();
        const selectedColor = getComputedStyle(document.documentElement).getPropertyValue('--success-color').trim();
        const handleLineColor = getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim();
        const curveColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim();

        // Draw handles first
        ctx.strokeStyle = handleLineColor; ctx.lineWidth = scaledHandleLineWidth;
        for (let i = 0; i < anchors.length - 1; i++) {
            const p0 = anchors[i]; const p3 = anchors[i + 1]; const cp = controls[i];
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(cp.cp1x, cp.cp1y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(cp.cp2x, cp.cp2y); ctx.stroke();
        }

         // Draw control points (circles)
         for (let i = 0; i < controls.length; i++) {
             const cp = controls[i];
             ctx.fillStyle = (selectedPoint.type === 'control' && selectedPoint.index === i && selectedPoint.handle === 1) ? selectedColor : controlColor;
             ctx.beginPath(); ctx.arc(cp.cp1x, cp.cp1y, scaledHandleRadius, 0, Math.PI * 2); ctx.fill();
             ctx.fillStyle = (selectedPoint.type === 'control' && selectedPoint.index === i && selectedPoint.handle === 2) ? selectedColor : controlColor;
             ctx.beginPath(); ctx.arc(cp.cp2x, cp.cp2y, scaledHandleRadius, 0, Math.PI * 2); ctx.fill();
         }

        // Draw anchor points (squares)
        for (let i = 0; i < anchors.length; i++) {
            const p = anchors[i];
            ctx.fillStyle = (selectedPoint.type === 'anchor' && selectedPoint.index === i) ? selectedColor : anchorColor;
            ctx.fillRect(p.x - scaledPointSize / 2, p.y - scaledPointSize / 2, scaledPointSize, scaledPointSize);
        }

        // Draw Curve
        ctx.strokeStyle = curveColor; ctx.lineWidth = Math.max(1, 2 / dpr); ctx.beginPath();
        ctx.moveTo(anchors[0].x, anchors[0].y);
        for (let i = 0; i < anchors.length - 1; i++) {
            const p0 = anchors[i]; const p3 = anchors[i + 1]; const cp = controls[i];
            ctx.bezierCurveTo(cp.cp1x, cp.cp1y, cp.cp2x, cp.cp2y, p3.x, p3.y);
        }
        ctx.stroke();
    }

    // --- Generate Waveform from Bezier (Exposed Globally) ---
    window.generateWaveformFromBezier = function() {
         if (!anchors || anchors.length < 2) {
             waveformData = new Array(currentLength).fill(currentCenterValue);
             console.warn("Bezier: Not enough anchor points to generate waveform.");
             if(typeof updateOutputTextarea === 'function') updateOutputTextarea();
             return;
         }

         const newData = new Array(currentLength);
         let segmentIndex = 0;

         for (let i = 0; i < currentLength; i++) {
             const targetX = (i + 0.5) * cellWidth;
             let foundY = centerY;

             // Optimize segment finding: If targetX is before the current segment's start, reset search
             if(targetX < anchors[segmentIndex].x) {
                segmentIndex = 0;
             }
             // Advance segmentIndex if targetX is beyond the next anchor's X
             while (segmentIndex < anchors.length - 2 && targetX > anchors[segmentIndex + 1].x) {
                 segmentIndex++;
             }
             segmentIndex = Math.min(segmentIndex, anchors.length - 2); // Clamp index

             if (segmentIndex >= 0) {
                 const p0 = anchors[segmentIndex]; const p3 = anchors[segmentIndex + 1]; const cp = controls[segmentIndex];
                 const minX = Math.min(p0.x, p3.x); const maxX = Math.max(p0.x, p3.x); const tolerance = 0.01; // Use small tolerance

                  if (Math.abs(p0.x - p3.x) < tolerance) { // Vertical line
                      if (Math.abs(targetX - p0.x) < cellWidth / 2) { foundY = (p0.y + p3.y) / 2; } // Average Y if on the line
                      else { foundY = targetX < p0.x ? p0.y : p3.y; } // Use endpoint Y if outside X
                  } else if (targetX >= minX - tolerance && targetX <= maxX + tolerance) { // Within segment X range
                       foundY = findYatX(targetX, p0, {x: cp.cp1x, y: cp.cp1y}, {x: cp.cp2x, y: cp.cp2y}, p3);
                  } else if (targetX < minX) { foundY = p0.y; } // Before segment start
                  else { foundY = p3.y; } // After segment end
             } else { foundY = anchors.length > 0 ? anchors[0].y : centerY; } // Fallback

             const rawValue = (baseHeight - foundY) / stepHeight;
             newData[i] = quantizeValue(rawValue);
         }

         waveformData = newData;
         if(typeof updateOutputTextarea === 'function') updateOutputTextarea();
     }


    // --- Interaction Logic ---

    function findClickedPoint(pos) {
         const hitRadiusSq = Math.pow(hitThreshold / dpr, 2);
         // Check anchors (squares: check distance to center)
         const scaledPointSize = pointSize / dpr;
         for (let i = anchors.length - 1; i >= 0; i--) {
             // Simple bounding box check first for square
              if (pos.x >= anchors[i].x - scaledPointSize / 2 - hitThreshold / dpr &&
                  pos.x <= anchors[i].x + scaledPointSize / 2 + hitThreshold / dpr &&
                  pos.y >= anchors[i].y - scaledPointSize / 2 - hitThreshold / dpr &&
                  pos.y <= anchors[i].y + scaledPointSize / 2 + hitThreshold / dpr) {
                 // More precise check if needed, but box is often enough
                 return { type: 'anchor', index: i, handle: 0 };
             }
         }
         // Check control points (circles)
         for (let i = controls.length - 1; i >= 0; i--) {
             if (distSq(pos, {x: controls[i].cp1x, y: controls[i].cp1y}) < hitRadiusSq) { return { type: 'control', index: i, handle: 1 }; }
             if (distSq(pos, {x: controls[i].cp2x, y: controls[i].cp2y}) < hitRadiusSq) { return { type: 'control', index: i, handle: 2 }; }
         }
         return { type: null, index: -1, handle: 0 };
    }

     function addBezierPoint(pos) {
         let bestT = -1; let bestSegment = -1;
         let minDistSq = Math.pow(hitThreshold * 1.5 / dpr, 2); // Use squared threshold

         for (let seg = 0; seg < anchors.length - 1; seg++) {
             const p0 = anchors[seg]; const p3 = anchors[seg+1]; const cp = controls[seg];
             const closest = findClosestPointOnSegment(pos, p0, {x:cp.cp1x, y:cp.cp1y}, {x:cp.cp2x, y:cp.cp2y}, p3);
             if (closest.distSq < minDistSq) { minDistSq = closest.distSq; bestT = closest.t; bestSegment = seg; }
         }

         if (bestSegment !== -1) {
             console.log(`Adding point in segment ${bestSegment} at t=${bestT}`);
             const p0 = anchors[bestSegment]; const p3 = anchors[bestSegment+1]; const cp = controls[bestSegment];
             const split = subdivideBezier(p0, {x:cp.cp1x, y:cp.cp1y}, {x:cp.cp2x, y:cp.cp2y}, p3, bestT);
             const newAnchor = split.first.p3;
             // Prevent adding point too close to existing anchors
             if (distSq(newAnchor, p0) < 1 || distSq(newAnchor, p3) < 1) {
                 console.log("New point too close to existing anchor, skipping add.");
                 return;
             }
             const controls1 = { cp1x: split.first.p1.x, cp1y: split.first.p1.y, cp2x: split.first.p2.x, cp2y: split.first.p2.y };
             const controls2 = { cp1x: split.second.p1.x, cp1y: split.second.p1.y, cp2x: split.second.p2.x, cp2y: split.second.p2.y };
             anchors.splice(bestSegment + 1, 0, newAnchor);
             controls.splice(bestSegment + 1, 0, controls2);
             controls[bestSegment] = controls1;
             selectedPoint = { type: 'anchor', index: bestSegment + 1, handle: 0 };
             generateWaveformFromBezier();
             if (typeof redraw === 'function') redraw();
         }
     }

    // --- Event Handlers (Exposed Globally) ---
    window.bezierMouseDown = function(event) {
        event.preventDefault();
        const pos = getEventCoords(event);
        selectedPoint = findClickedPoint(pos);

        if (selectedPoint.type) {
            isDraggingBezierPoint = true;
            let currentPointPos;
            if (selectedPoint.type === 'anchor') currentPointPos = anchors[selectedPoint.index];
            else if (selectedPoint.handle === 1) currentPointPos = { x: controls[selectedPoint.index].cp1x, y: controls[selectedPoint.index].cp1y };
            else currentPointPos = { x: controls[selectedPoint.index].cp2x, y: controls[selectedPoint.index].cp2y };
            dragOffsetX = pos.x - currentPointPos.x;
            dragOffsetY = pos.y - currentPointPos.y;
            canvas.style.cursor = 'grabbing';
        } else {
             addBezierPoint(pos);
        }
        if (typeof redraw === 'function') redraw();
    }

    window.bezierMouseMove = function(event) {
        if (!isDraggingBezierPoint || !selectedPoint.type) return;
        event.preventDefault();

        const pos = getEventCoords(event);
        const newX = pos.x - dragOffsetX;
        const newY = pos.y - dragOffsetY;
        let clampedX = newX; let clampedY = newY;

        // Clamp Y to canvas boundaries
        clampedY = Math.max(0, Math.min(baseHeight, newY));

         // Clamp X to canvas boundaries, but allow slight overshoot for control points? No, clamp all.
         clampedX = Math.max(0, Math.min(baseWidth, newX));

        // Special handling for first and last anchors (fixed X)
        if (selectedPoint.type === 'anchor' && (selectedPoint.index === 0 || selectedPoint.index === anchors.length - 1)) {
              clampedX = anchors[selectedPoint.index].x; // Keep original X
        }

        // Update positions
        if (selectedPoint.type === 'anchor') {
            const index = selectedPoint.index;
             const deltaX = clampedX - anchors[index].x;
             const deltaY = clampedY - anchors[index].y;
             anchors[index].x = clampedX; anchors[index].y = clampedY;
            // Move associated control points
            if (index > 0) { controls[index - 1].cp2x += deltaX; controls[index - 1].cp2y += deltaY; }
            if (index < controls.length) { controls[index].cp1x += deltaX; controls[index].cp1y += deltaY; }
        } else if (selectedPoint.type === 'control') {
            const index = selectedPoint.index;
             if (selectedPoint.handle === 1) { controls[index].cp1x = clampedX; controls[index].cp1y = clampedY; }
             else { controls[index].cp2x = clampedX; controls[index].cp2y = clampedY; }
        }

        generateWaveformFromBezier();
        if (typeof redraw === 'function') redraw();
    }

    window.bezierMouseUp = function(event) {
        if (isDraggingBezierPoint) {
            isDraggingBezierPoint = false;
            // Use global currentEditMode from main script
            canvas.style.cursor = currentEditMode === 'bezier' ? 'default' : 'crosshair';
            if (typeof redraw === 'function') redraw();
        }
    }

     window.bezierTouchStart = function(event) { if (event.touches.length === 1) { event.preventDefault(); bezierMouseDown(event); } }
     window.bezierTouchMove = function(event) { if (isDraggingBezierPoint && event.touches.length === 1) { event.preventDefault(); bezierMouseMove(event); } }
     window.bezierTouchEnd = function(event) { bezierMouseUp(event); }
     window.bezierTouchCancel = function(event) { bezierMouseUp(event); }

    // --- Initial Bezier Setup on Load ---
    // Delay initialization slightly to ensure main script variables are ready
    setTimeout(initializeBezier, 100);

    console.log("Bezier Editor Script Initialized.");

})(); // End IIFE