# 3D Constraint Function Visualizer Design

## Goal

Build an interactive browser-based 3D function visualizer. The first version must reliably render visible 3D shapes inside a coordinate carrier similar to the provided reference image: a transparent coordinate box, grid plane, axes, ticks, and an editable mathematical surface.

The product should support user-entered mathematical expressions, variable ranges, constraints, and partial-region display. It should also leave a clear path for high-dimensional calculation by projecting or slicing higher-dimensional relationships into a 3D view.

## Users

The primary user is someone exploring mathematical functions, implicit surfaces, constrained regions, or sampled data in a browser. The interface should make it possible to enter a function, set ranges and constraints, render the result, and inspect the generated shape by rotating, zooming, and clicking.

## Core Scope

The first version supports four data modes:

1. Explicit surface: `z = f(x,y)`
2. Parametric surface: `x(u,v), y(u,v), z(u,v)`
3. Implicit surface: `F(x,y,z)=0`, rendered with Marching Cubes
4. Discrete points: sampled point data displayed as a point cloud

Every mode passes through the same display controls:

- Variable ranges
- Sampling resolution
- Constraint filtering
- 3D axis selection
- Basic material and lighting

## Priorities

The implementation priority is:

1. Render the correct 3D shape first.
2. Make navigation reliable: rotate, zoom, and pan.
3. Show the coordinate carrier clearly: box, axes, grid, ticks, and labels.
4. Add basic visual quality: color, lighting, and specular highlights.
5. Add shadows, contours, and advanced highlighting later.

The first version should not let shadows, high-end rendering, or high-dimensional numerical solving delay the core result: a visible 3D shape generated from user input.

## Interaction Design

The page has two primary regions.

The left control panel contains:

- Function mode selector
- Expression inputs
- Variable range inputs
- Constraint input
- Sampling resolution control
- Example presets
- Render button
- Error and status area

The right viewport contains:

- Three.js scene
- Transparent coordinate box
- Main grid plane
- X, Y, and Z axes
- Tick marks and labels
- Rendered function geometry
- Click inspection marker and coordinate readout

Mouse interaction uses OrbitControls:

- Drag to rotate
- Scroll to zoom
- Right drag or equivalent gesture to pan

## Expression Handling

Expressions must be parsed through a math expression parser rather than direct JavaScript execution. The parser should support common math syntax and functions such as:

- `sin`, `cos`, `tan`
- `sqrt`, `abs`, `log`, `exp`
- `min`, `max`, `pow`
- Constants such as `pi` and `e`

The UI may accept `^` for exponentiation and normalize it through the parser.

Invalid expressions should produce a visible error message and leave the current valid render intact.

## Explicit Surface Mode

Input:

- Expression: `z = f(x,y)`
- Ranges: `xMin`, `xMax`, `yMin`, `yMax`
- Optional display range: `zMin`, `zMax`
- Constraint expression, such as `x^2 + y^2 < 9`

Process:

- Sample a 2D grid over the x/y range.
- Evaluate `z` for every sample.
- Drop invalid values such as `NaN` and `Infinity`.
- Apply constraints and z-range clipping.
- Build a `BufferGeometry` surface from valid neighboring samples.

Output:

- A shaded mesh, optionally with wireframe overlay in later versions.

## Parametric Surface Mode

Input:

- Expressions: `x(u,v)`, `y(u,v)`, `z(u,v)`
- Ranges: `uMin`, `uMax`, `vMin`, `vMax`
- Optional constraints over `x`, `y`, `z`, `u`, and `v`

Process:

- Sample the u/v parameter grid.
- Evaluate the three coordinate expressions.
- Drop invalid points.
- Apply constraints and range clipping.
- Build a surface mesh from valid neighboring samples.

Output:

- A shaded parametric surface.

## Implicit Surface Mode

Input:

- Expression: `F(x,y,z)`
- Iso value, default `0`
- Ranges: `xMin`, `xMax`, `yMin`, `yMax`, `zMin`, `zMax`
- Resolution control
- Optional constraints over `x`, `y`, and `z`

Process:

- Sample a 3D scalar field over the selected range.
- Extract the iso-surface using Marching Cubes.
- Apply constraints where practical by rejecting vertices or cells outside allowed regions.
- Generate normals for lighting.

Output:

- A shaded mesh approximating `F(x,y,z)=isoValue`.

Accuracy depends on the selected grid resolution. The UI should make this trade-off visible: higher resolution improves detail but costs performance.

## Discrete Point Mode

Input:

- Point data entered manually or selected from an example in the first version
- Optional constraints over point coordinates

Process:

- Parse points as numeric tuples.
- Apply constraints and range clipping.
- Render valid points as a point cloud.

Output:

- A 3D point cloud inside the same coordinate carrier.

CSV import can be added later if needed.

## Constraint Filtering

Constraints are additional boolean expressions, for example:

- `x > 0`
- `z <= 2`
- `x^2 + y^2 < 9`
- `z >= 0 && x < 3`

Constraints should be evaluated against each generated point or sample. Points that do not satisfy the condition are not displayed. For mesh modes, triangles should be emitted only when their vertices satisfy the relevant validity checks.

This keeps partial-region display consistent across explicit, parametric, implicit, and discrete modes.

## High-Dimensional Support

The browser viewport remains 3D. Higher-dimensional support is handled through projection and slicing rather than direct high-dimensional display.

The design supports:

- User-defined variable list, such as `x,y,z,w,t`
- Choice of three display axes, such as `x,y,z`
- Fixed values for non-displayed variables, such as `w=1,t=0`
- Future slice controls for moving fixed variables interactively

First-version high-dimensional support is architectural: the UI and expression evaluator should not hard-code every concept in a way that blocks future variables. Full N-dimensional numerical solving is out of scope for the first version.

## Position Inspection

The viewport should support basic coordinate inspection:

- Clicking a rendered mesh or point shows the approximate coordinate.
- The selected coordinate appears in a small readout in the panel or overlay.
- A small marker can be placed at the selected point.

For explicit and parametric surfaces, this is approximate geometry picking. For implicit surfaces, this is also approximate because the mesh comes from sampled Marching Cubes geometry.

## Visual Design

The visual style should match a technical graphing tool rather than a marketing page.

The scene should include:

- White or very light background
- Pale gray coordinate box
- Medium gray axes
- Darker labels for X, Y, and Z
- Main grid and lighter sub-grid lines
- Function mesh with a clear color and basic specular highlight
- Ambient light and directional light

The first version should include basic lighting and highlights so the shape has readable depth. Cast shadows are optional for the first version and should not block core rendering.

## Error Handling

The app should handle these cases without crashing:

- Parse errors
- Unknown variables
- Invalid numeric ranges
- Resolution too high
- Functions that produce no valid points
- Implicit extraction that produces no surface in the selected range

When rendering fails, show a clear message and keep the previous valid geometry visible when possible.

## Performance Constraints

The app runs in the browser, so sampling must be bounded.

Recommended first-version limits:

- Explicit and parametric resolution capped around 160 by 160 samples
- Implicit resolution capped around 48 to 64 per axis, depending on performance
- Point count capped for manual input

The UI should expose resolution as a quality/performance trade-off.

## Acceptance Criteria

The implementation is acceptable when:

- `z = sin(x) * cos(y)` renders as a shaded 3D surface.
- A sphere-like parametric example renders with visible volume.
- `x^2 + y^2 + z^2 - 4` renders as an approximate implicit sphere.
- A constraint such as `z >= 0` displays only part of a surface.
- Variable ranges change the displayed region.
- Drag, zoom, and pan work in the 3D viewport.
- Axes, grid, coordinate box, ticks, and labels are visible.
- Invalid expressions show an error instead of breaking the page.
- The first version includes basic lighting or highlights so the 3D shape is readable.

## Out of Scope for First Version

- Production-grade symbolic math
- Full N-dimensional equation solving
- Ray-traced implicit rendering
- Advanced shadows and global illumination
- CSV import and large dataset processing
- Multi-user sharing or persistence

These can be added later after the first version reliably renders user-entered 3D shapes.
