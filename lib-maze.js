'use strict';
/* 随机迷宫生成（每回合不同）+ 出生点适配，供 server.js 与测试共用 */

/**
 * 递归深搜生成完美迷宫（所有通道连通）
 * @param {number} cols 列数
 * @param {number} rows 行数
 * @param {number} worldW 世界宽
 * @param {number} worldH 世界高
 * @param {number} wallT 隔墙厚度
 * @returns {Array<{x,y,w,h}>} 障碍矩形数组
 */
function generateMaze(cols, rows, worldW, worldH, wallT) {
  const CELL_W = worldW / cols, CELL_H = worldH / rows;
  const hWalls = Array.from({ length: cols }, () => Array(rows - 1).fill(true));
  const vWalls = Array.from({ length: cols - 1 }, () => Array(rows).fill(true));
  const visited = Array.from({ length: cols }, () => Array(rows).fill(false));
  const stack = [[Math.floor(Math.random() * cols), Math.floor(Math.random() * rows)]];
  visited[stack[0][0]][stack[0][1]] = true;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const nb = [];
    if (cx > 0 && !visited[cx - 1][cy]) nb.push([cx - 1, cy, 'L']);
    if (cx < cols - 1 && !visited[cx + 1][cy]) nb.push([cx + 1, cy, 'R']);
    if (cy > 0 && !visited[cx][cy - 1]) nb.push([cx, cy - 1, 'U']);
    if (cy < rows - 1 && !visited[cx][cy + 1]) nb.push([cx, cy + 1, 'D']);
    if (!nb.length) { stack.pop(); continue; }
    const [nx, ny, dir] = nb[Math.floor(Math.random() * nb.length)];
    if (dir === 'L') vWalls[cx - 1][cy] = false;
    else if (dir === 'R') vWalls[cx][cy] = false;
    else if (dir === 'U') hWalls[cx][cy - 1] = false;
    else hWalls[cx][cy] = false;
    visited[nx][ny] = true;
    stack.push([nx, ny]);
  }
  const obstacles = [];
  const W = wallT;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows - 1; j++) {
      if (hWalls[i][j]) obstacles.push({ x: i * CELL_W - W / 2, y: (j + 1) * CELL_H - W / 2, w: CELL_W + W, h: W });
    }
  }
  for (let i = 0; i < cols - 1; i++) {
    for (let j = 0; j < rows; j++) {
      if (vWalls[i][j]) obstacles.push({ x: (i + 1) * CELL_W - W / 2, y: j * CELL_H - W / 2, w: W, h: CELL_H + W });
    }
  }
  return obstacles;
}

/**
 * 把点移到最近的迷宫通道格子中心（格子中心必为通道：墙只存在于格子边界）
 * @param {Array} obstacles 迷宫障碍矩形
 * @param {number} x,y 期望位置
 * @param {number} pad 外扩半径（坦克半径）
 * @param {number} worldW,worldH 世界尺寸
 * @param {number} wallT 外边界墙厚
 * @param {Set<string>} [used] 已占用的格子标记（避免多名玩家挤同一格）
 */
function fitSpawn(obstacles, x, y, pad, worldW, worldH, wallT, used) {
  const inWall = (px, py) => obstacles.some((o) => px >= o.x - pad && px <= o.x + o.w + pad && py >= o.y - pad && py <= o.y + o.h + pad);
  if (!inWall(x, y) && !(used && used.has(Math.round(x / (worldW / 10)) + ',' + Math.round(y / (worldH / 8))))) return { x, y };
  const cols = 10, rows = 8;
  const cw = worldW / cols, ch = worldH / rows;
  let best = null, bestD = Infinity;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const px = i * cw + cw / 2, py = j * ch + ch / 2;
      if (inWall(px, py)) continue;
      if (used && used.has(i + ',' + j)) continue;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bestD) { bestD = d; best = { x: px, y: py, key: i + ',' + j }; }
    }
  }
  if (best) {
    if (used) used.add(best.key);
    return { x: best.x, y: best.y };
  }
  return { x: worldW / 2, y: worldH / 2 };
}

module.exports = { generateMaze, fitSpawn };
