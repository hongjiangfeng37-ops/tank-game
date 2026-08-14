'use strict';
/* 几何工具：线段与轴对齐矩形碰撞检测（子弹防隧穿用） */

/**
 * 检测线段 (x0,y0)->(x1,y1) 是否与矩形 r 相交
 * @param {number} x0,y0 线段起点（上一帧位置）
 * @param {number} x1,y1 线段终点（当前位置）
 * @param {{x:number,y:number,w:number,h:number}} r 轴对齐矩形
 * @returns {{x:number,y:number,nx:number,ny:number}|null} 最近交点与表面法线（法线指向子弹来向），无交点返回 null
 */
function segRectHit(x0, y0, x1, y1, r) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let txIn = 0, txOut = 1, nxSide = 0;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < r.x || x0 > r.x + r.w) return null;
  } else {
    let t1 = (r.x - x0) / dx;
    let t2 = (r.x + r.w - x0) / dx;
    let n1 = -1, n2 = 1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; const n = n1; n1 = n2; n2 = n; }
    txIn = t1; txOut = t2; nxSide = n1;
  }
  let tyIn = 0, tyOut = 1, nySide = 0;
  if (Math.abs(dy) < 1e-9) {
    if (y0 < r.y || y0 > r.y + r.h) return null;
  } else {
    let t1 = (r.y - y0) / dy;
    let t2 = (r.y + r.h - y0) / dy;
    let n1 = -1, n2 = 1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; const n = n1; n1 = n2; n2 = n; }
    tyIn = t1; tyOut = t2; nySide = n1;
  }
  const tIn = Math.max(txIn, tyIn);
  const tOut = Math.min(txOut, tyOut);
  if (tIn > 0 && tIn <= 1 && tIn <= tOut) {
    return {
      x: x0 + dx * tIn,
      y: y0 + dy * tIn,
      nx: tIn === txIn ? nxSide : 0,
      ny: tIn === tyIn ? nySide : 0,
    };
  }
  return null;
}

module.exports = { segRectHit };
