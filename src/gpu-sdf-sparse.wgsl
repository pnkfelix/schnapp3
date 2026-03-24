// WebGPU compute shader: SDF tape interpreter — sparse point variant.
// Same tape evaluation as gpu-sdf.wgsl but reads coordinates from a buffer
// instead of computing them from a uniform 3D grid. Used with octree culling:
// the CPU builds the octree via interval arithmetic and uploads only the
// coordinates that need evaluation.

// --- Bindings ---

struct SparseParams {
  num_points: u32,
  tape_len: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: SparseParams;
@group(0) @binding(1) var<storage, read> tape: array<f32>;
@group(0) @binding(2) var<storage, read> in_coords: array<f32>;  // [x,y,z, x,y,z, ...]
@group(0) @binding(3) var<storage, read_write> out_distance: array<f32>;
@group(0) @binding(4) var<storage, read_write> out_polarity: array<f32>;
@group(0) @binding(5) var<storage, read_write> out_color: array<f32>;

// Opcodes — must match gpu-tape.js
const OP_SPHERE: u32     = 1u;
const OP_CUBE: u32       = 2u;
const OP_CYLINDER: u32   = 3u;
const OP_TRANSLATE: u32  = 4u;
const OP_UNION: u32      = 5u;
const OP_INTERSECT: u32  = 6u;
const OP_ANTI: u32       = 7u;
const OP_COMPLEMENT: u32 = 8u;
const OP_FUSE: u32       = 9u;
const OP_PAINT: u32      = 10u;
const OP_MIRROR: u32     = 11u;
const OP_ROTATE: u32     = 12u;
const OP_TWIST: u32      = 13u;
const OP_RADIAL: u32     = 14u;
const OP_STRETCH: u32    = 15u;
const OP_TILE: u32       = 16u;
const OP_BEND: u32       = 17u;
const OP_TAPER: u32      = 18u;
const OP_POP_TRANSFORM: u32 = 19u;

const MAX_COORD_DEPTH: u32 = 16u;
const MAX_VAL_DEPTH: u32 = 32u;

const UNSET_COLOR: f32 = -1.0;
const DEFAULT_GRAY_R: f32 = 0.6666667;
const DEFAULT_GRAY_G: f32 = 0.6666667;
const DEFAULT_GRAY_B: f32 = 0.6666667;

const PI: f32 = 3.14159265358979323846;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.num_points) { return; }

  // Read position from input coordinate buffer
  let base_x = in_coords[idx * 3u];
  let base_y = in_coords[idx * 3u + 1u];
  let base_z = in_coords[idx * 3u + 2u];

  // Coordinate stack (transforms push/pop current position)
  var cx: array<f32, 16>;
  var cy: array<f32, 16>;
  var cz: array<f32, 16>;
  var coord_sp: u32 = 0u;
  var px = base_x;
  var py = base_y;
  var pz = base_z;

  // Value stack: each entry is (polarity, distance, r, g, b)
  var vs_pol: array<f32, 32>;
  var vs_dist: array<f32, 32>;
  var vs_cr: array<f32, 32>;
  var vs_cg: array<f32, 32>;
  var vs_cb: array<f32, 32>;
  var val_sp: u32 = 0u;

  // Interpret the tape
  var pc: u32 = 0u;
  let tape_len = params.tape_len;

  loop {
    if (pc >= tape_len) { break; }
    let op = bitcast<u32>(tape[pc]);
    pc = pc + 1u;

    switch (op) {
      case 1u: { // OP_SPHERE
        let radius = tape[pc]; pc = pc + 1u;
        let d = sqrt(px*px + py*py + pz*pz) - radius;
        var pol: f32 = 0.0;
        if (d <= 0.0) { pol = 1.0; }
        vs_pol[val_sp] = pol;
        vs_dist[val_sp] = d;
        vs_cr[val_sp] = UNSET_COLOR;
        vs_cg[val_sp] = UNSET_COLOR;
        vs_cb[val_sp] = UNSET_COLOR;
        val_sp = val_sp + 1u;
      }
      case 2u: { // OP_CUBE
        let half = tape[pc] * 0.5; pc = pc + 1u;
        let qx = abs(px) - half;
        let qy = abs(py) - half;
        let qz = abs(pz) - half;
        let outside = sqrt(max(qx, 0.0) * max(qx, 0.0) + max(qy, 0.0) * max(qy, 0.0) + max(qz, 0.0) * max(qz, 0.0));
        let inside_val = min(max(qx, max(qy, qz)), 0.0);
        let d = outside + inside_val;
        var pol: f32 = 0.0;
        if (d <= 0.0) { pol = 1.0; }
        vs_pol[val_sp] = pol;
        vs_dist[val_sp] = d;
        vs_cr[val_sp] = UNSET_COLOR;
        vs_cg[val_sp] = UNSET_COLOR;
        vs_cb[val_sp] = UNSET_COLOR;
        val_sp = val_sp + 1u;
      }
      case 3u: { // OP_CYLINDER
        let radius = tape[pc]; pc = pc + 1u;
        let height = tape[pc]; pc = pc + 1u;
        let dx = sqrt(px*px + pz*pz) - radius;
        let dy = abs(py) - height * 0.5;
        let outside = sqrt(max(dx, 0.0) * max(dx, 0.0) + max(dy, 0.0) * max(dy, 0.0));
        let inside_val = min(max(dx, dy), 0.0);
        let d = outside + inside_val;
        var pol: f32 = 0.0;
        if (d <= 0.0) { pol = 1.0; }
        vs_pol[val_sp] = pol;
        vs_dist[val_sp] = d;
        vs_cr[val_sp] = UNSET_COLOR;
        vs_cg[val_sp] = UNSET_COLOR;
        vs_cb[val_sp] = UNSET_COLOR;
        val_sp = val_sp + 1u;
      }
      case 4u: { // OP_TRANSLATE
        let tx = tape[pc]; pc = pc + 1u;
        let ty = tape[pc]; pc = pc + 1u;
        let tz = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px;
        cy[coord_sp] = py;
        cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        px = px - tx;
        py = py - ty;
        pz = pz - tz;
      }
      case 5u: { // OP_UNION
        let n_u32 = bitcast<u32>(tape[pc]); pc = pc + 1u;
        if (n_u32 >= 2u && val_sp >= n_u32) {
          let start = val_sp - n_u32;
          var best_idx = start;
          var p_sum: f32 = 0.0;
          for (var i = start; i < val_sp; i = i + 1u) {
            p_sum = p_sum + vs_pol[i];
            if (vs_dist[i] < vs_dist[best_idx]) { best_idx = i; }
          }
          let d = vs_dist[best_idx];
          var cr = vs_cr[best_idx]; var cg = vs_cg[best_idx]; var cb = vs_cb[best_idx];
          if (cr == UNSET_COLOR) {
            for (var i = start; i < val_sp; i = i + 1u) {
              if (vs_cr[i] != UNSET_COLOR) { cr = vs_cr[i]; cg = vs_cg[i]; cb = vs_cb[i]; break; }
            }
          }
          vs_pol[start] = sign(p_sum); vs_dist[start] = d;
          vs_cr[start] = cr; vs_cg[start] = cg; vs_cb[start] = cb;
          val_sp = start + 1u;
        }
      }
      case 6u: { // OP_INTERSECT
        let n_u32 = bitcast<u32>(tape[pc]); pc = pc + 1u;
        if (n_u32 >= 2u && val_sp >= n_u32) {
          let start = val_sp - n_u32;
          var p_prod = vs_pol[start];
          var best_idx = start;
          for (var i = start + 1u; i < val_sp; i = i + 1u) {
            p_prod = p_prod * vs_pol[i];
            if (vs_dist[i] > vs_dist[best_idx]) { best_idx = i; }
          }
          let d = vs_dist[best_idx];
          var cr = vs_cr[best_idx]; var cg = vs_cg[best_idx]; var cb = vs_cb[best_idx];
          if (cr == UNSET_COLOR) {
            for (var i = start; i < val_sp; i = i + 1u) {
              if (vs_cr[i] != UNSET_COLOR) { cr = vs_cr[i]; cg = vs_cg[i]; cb = vs_cb[i]; break; }
            }
          }
          vs_pol[start] = p_prod; vs_dist[start] = d;
          vs_cr[start] = cr; vs_cg[start] = cg; vs_cb[start] = cb;
          val_sp = start + 1u;
        }
      }
      case 7u: { // OP_ANTI
        if (val_sp >= 1u) { vs_pol[val_sp - 1u] = -vs_pol[val_sp - 1u]; }
      }
      case 8u: { // OP_COMPLEMENT
        if (val_sp >= 1u) { vs_dist[val_sp - 1u] = -vs_dist[val_sp - 1u]; }
      }
      case 9u: { // OP_FUSE
        let n_u32 = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let k = tape[pc]; pc = pc + 1u;
        if (n_u32 >= 2u && val_sp >= n_u32) {
          let start = val_sp - n_u32;
          var p_sum: f32 = 0.0;
          var max_neg: f32 = -1e30;
          for (var i = start; i < val_sp; i = i + 1u) {
            p_sum = p_sum + vs_pol[i];
            let neg_val = -vs_dist[i] / k;
            if (neg_val > max_neg) { max_neg = neg_val; }
          }
          var exp_sum: f32 = 0.0;
          for (var i = start; i < val_sp; i = i + 1u) {
            exp_sum = exp_sum + exp(-vs_dist[i] / k - max_neg);
          }
          let dist = -k * (log(exp_sum) + max_neg);
          var total_set_w: f32 = 0.0;
          var br: f32 = 0.0; var bg: f32 = 0.0; var bb: f32 = 0.0;
          for (var i = start; i < val_sp; i = i + 1u) {
            let w = exp(-vs_dist[i] / k - max_neg);
            if (vs_cr[i] != UNSET_COLOR) {
              total_set_w = total_set_w + w;
              br = br + vs_cr[i] * w; bg = bg + vs_cg[i] * w; bb = bb + vs_cb[i] * w;
            }
          }
          var cr = UNSET_COLOR; var cg = UNSET_COLOR; var cb = UNSET_COLOR;
          if (total_set_w > 0.0) { cr = br / total_set_w; cg = bg / total_set_w; cb = bb / total_set_w; }
          vs_pol[start] = sign(p_sum); vs_dist[start] = dist;
          vs_cr[start] = cr; vs_cg[start] = cg; vs_cb[start] = cb;
          val_sp = start + 1u;
        }
      }
      case 10u: { // OP_PAINT
        let r = tape[pc]; pc = pc + 1u;
        let g = tape[pc]; pc = pc + 1u;
        let b = tape[pc]; pc = pc + 1u;
        if (val_sp >= 1u) { vs_cr[val_sp - 1u] = r; vs_cg[val_sp - 1u] = g; vs_cb[val_sp - 1u] = b; }
      }
      case 11u: { // OP_MIRROR
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        if (axis == 0u) { px = abs(px); }
        else if (axis == 1u) { py = abs(py); }
        else { pz = abs(pz); }
      }
      case 12u: { // OP_ROTATE
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let cos_a = tape[pc]; pc = pc + 1u;
        let sin_a = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        if (axis == 1u) {
          let nx = cos_a * px - sin_a * pz; let nz = sin_a * px + cos_a * pz;
          px = nx; pz = nz;
        } else if (axis == 0u) {
          let ny_val = cos_a * py - sin_a * pz; let nz = sin_a * py + cos_a * pz;
          py = ny_val; pz = nz;
        } else {
          let nx = cos_a * px - sin_a * py; let ny_val = sin_a * px + cos_a * py;
          px = nx; py = ny_val;
        }
      }
      case 13u: { // OP_TWIST
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let rate = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        var along: f32; var u: f32; var v: f32;
        if (axis == 1u) { along = py; u = px; v = pz; }
        else if (axis == 0u) { along = px; u = py; v = pz; }
        else { along = pz; u = px; v = py; }
        let angle = -rate * along;
        let c = cos(angle); let s = sin(angle);
        let ru = c * u - s * v; let rv = s * u + c * v;
        if (axis == 1u) { px = ru; pz = rv; }
        else if (axis == 0u) { py = ru; pz = rv; }
        else { px = ru; py = rv; }
      }
      case 14u: { // OP_RADIAL
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let sector = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        var u: f32; var v: f32; var w: f32;
        if (axis == 1u) { u = px; v = pz; w = py; }
        else if (axis == 0u) { u = py; v = pz; w = px; }
        else { u = px; v = py; w = pz; }
        var angle = atan2(v, u);
        if (angle < 0.0) { angle = angle + 2.0 * PI; }
        angle = angle % sector;
        if (angle > sector * 0.5) { angle = sector - angle; }
        let r = sqrt(u * u + v * v);
        let nu = r * cos(angle); let nv = r * sin(angle);
        if (axis == 1u) { px = nu; py = w; pz = nv; }
        else if (axis == 0u) { px = w; py = nu; pz = nv; }
        else { px = nu; py = nv; pz = w; }
      }
      case 15u: { // OP_STRETCH
        let sx = tape[pc]; pc = pc + 1u;
        let sy = tape[pc]; pc = pc + 1u;
        let sz = tape[pc]; pc = pc + 1u;
        let min_scale = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        px = px / sx; py = py / sy; pz = pz / sz;
      }
      case 16u: { // OP_TILE
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let spacing = tape[pc]; pc = pc + 1u;
        let half = spacing * 0.5;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        if (axis == 0u) { px = ((px % spacing) + spacing + half) % spacing - half; }
        else if (axis == 1u) { py = ((py % spacing) + spacing + half) % spacing - half; }
        else { pz = ((pz % spacing) + spacing + half) % spacing - half; }
      }
      case 17u: { // OP_BEND
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let rate = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        if (rate != 0.0) {
          var along: f32; var perp: f32; var w: f32;
          if (axis == 1u) { along = px; perp = py; w = pz; }
          else if (axis == 0u) { along = py; perp = px; w = pz; }
          else { along = px; perp = pz; w = py; }
          let bend_angle = along * rate;
          let c = cos(bend_angle); let s = sin(bend_angle);
          let r = perp + 1.0 / rate;
          let na = s * r; let np = c * r - 1.0 / rate;
          if (axis == 1u) { px = na; py = np; pz = w; }
          else if (axis == 0u) { px = np; py = na; pz = w; }
          else { px = na; py = w; pz = np; }
        }
      }
      case 18u: { // OP_TAPER
        let axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let rate = tape[pc]; pc = pc + 1u;
        cx[coord_sp] = px; cy[coord_sp] = py; cz[coord_sp] = pz;
        coord_sp = coord_sp + 1u;
        var along: f32;
        if (axis == 1u) { along = py; }
        else if (axis == 0u) { along = px; }
        else { along = pz; }
        let scale = max(0.01, 1.0 + rate * along);
        let inv_scale = 1.0 / scale;
        if (axis == 1u) { px = px * inv_scale; pz = pz * inv_scale; }
        else if (axis == 0u) { py = py * inv_scale; pz = pz * inv_scale; }
        else { px = px * inv_scale; py = py * inv_scale; }
      }
      case 19u: { // OP_POP_TRANSFORM
        if (coord_sp > 0u) {
          coord_sp = coord_sp - 1u;
          px = cx[coord_sp]; py = cy[coord_sp]; pz = cz[coord_sp];
        }
      }
      case 20u: { // OP_POP_TRANSFORM_SCALE
        let scale_factor = tape[pc]; pc = pc + 1u;
        if (coord_sp > 0u) {
          coord_sp = coord_sp - 1u;
          px = cx[coord_sp]; py = cy[coord_sp]; pz = cz[coord_sp];
        }
        if (val_sp >= 1u) { vs_dist[val_sp - 1u] = vs_dist[val_sp - 1u] * scale_factor; }
      }
      case 21u: { // OP_POP_TAPER
        let taper_axis = bitcast<u32>(tape[pc]); pc = pc + 1u;
        let taper_rate = tape[pc]; pc = pc + 1u;
        if (coord_sp > 0u) {
          coord_sp = coord_sp - 1u;
          let saved_x = cx[coord_sp]; let saved_y = cy[coord_sp]; let saved_z = cz[coord_sp];
          var taper_along: f32;
          if (taper_axis == 1u) { taper_along = saved_y; }
          else if (taper_axis == 0u) { taper_along = saved_x; }
          else { taper_along = saved_z; }
          let taper_scale = max(0.01, 1.0 + taper_rate * taper_along);
          if (val_sp >= 1u) { vs_dist[val_sp - 1u] = vs_dist[val_sp - 1u] * taper_scale; }
          px = saved_x; py = saved_y; pz = saved_z;
        }
      }
      default: {}
    }
  }

  // Write output
  if (val_sp >= 1u) {
    out_distance[idx] = vs_dist[0];
    out_polarity[idx] = vs_pol[0];
    var r_out = vs_cr[0]; var g_out = vs_cg[0]; var b_out = vs_cb[0];
    if (r_out == UNSET_COLOR) { r_out = DEFAULT_GRAY_R; g_out = DEFAULT_GRAY_G; b_out = DEFAULT_GRAY_B; }
    out_color[idx * 3u] = r_out;
    out_color[idx * 3u + 1u] = g_out;
    out_color[idx * 3u + 2u] = b_out;
  } else {
    out_distance[idx] = 1e10;
    out_polarity[idx] = 0.0;
    out_color[idx * 3u] = DEFAULT_GRAY_R;
    out_color[idx * 3u + 1u] = DEFAULT_GRAY_G;
    out_color[idx * 3u + 2u] = DEFAULT_GRAY_B;
  }
}
