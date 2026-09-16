// 인라인 SVG 아이콘. 이모지는 폰트에 따라 색·크기가 제각각이라 currentColor를 따르는 선 아이콘을 쓴다.
// CSP(default-src 'self')에서 data: URI 이미지는 막히므로 SVG 노드를 직접 만든다.
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(paths, size = 14) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.4');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  node.classList.add('ico');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    node.append(p);
  }
  return node;
}

window.ICONS = {
  search: (size) => svg(['M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z', 'M11 11l3.5 3.5'], size),
  plus: (size) => svg(['M8 3v10M3 8h10'], size),
  pin: (size) => svg(['M9.5 2l4.5 4.5-2.5 1-2.5 4-1.5 1.5L4 9.5 5.5 8l4-2.5z', 'M5.5 10.5L2 14'], size),
  archive: (size) => svg(['M2.5 4.5h11v9h-11z', 'M2 2.5h12v2H2z', 'M6.5 8h3'], size),
  trash: (size) => svg(['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.5 4.5l.7 8.5h5.6l.7-8.5'], size),
  eye: (size) => svg(['M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z', 'M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z'], size),
  edit: (size) => svg(['M11 2.5l2.5 2.5-8 8H3v-2.5z', 'M9.5 4l2.5 2.5'], size),
  link: (size) => svg(['M6.5 9.5l3-3', 'M7 4.5l1-1a2.2 2.2 0 0 1 3.1 3.1l-1 1', 'M9 11.5l-1 1a2.2 2.2 0 0 1-3.1-3.1l1-1'], size),
  back: (size) => svg(['M10 3L5 8l5 5'], size),
  clipboard: (size) => svg(['M5 3.5h6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z', 'M6.5 3.5V2.5h3v1'], size),
  image: (size) => svg(['M2.5 3.5h11v9h-11z', 'M2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5', 'M10.5 6.2a.7.7 0 1 0 0-1.4.7.7 0 0 0 0 1.4Z'], size),
};
