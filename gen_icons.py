#!/usr/bin/env python3
"""Wandercut 아이콘 생성기 — 외부 라이브러리 없이 PNG를 직접 인코딩한다.
보라→핑크 그라데이션 라운드 사각형 위에 흰색 재생 삼각형을 그린다."""
import struct, zlib, os

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_icon(size):
    C0 = (124, 92, 255)   # #7c5cff
    C1 = (255, 92, 151)   # #ff5c97
    r = max(2, int(size * 0.22))  # 코너 반경
    px = bytearray()
    cx, cy = size / 2, size / 2
    # 재생 삼각형 좌표(중앙 정렬)
    tw = size * 0.30
    th = size * 0.34
    tx0 = cx - tw * 0.35
    for y in range(size):
        px.append(0)  # 필터 타입 0
        for x in range(size):
            # 라운드 사각형 알파(코너 안티앨리어싱)
            inside = True
            corners = [(r, r), (size - r, r), (r, size - r), (size - r, size - r)]
            alpha = 255
            if x < r and y < r:
                d = ((x - r) ** 2 + (y - r) ** 2) ** 0.5; alpha = clampa(r - d)
            elif x > size - r and y < r:
                d = ((x - (size - r)) ** 2 + (y - r) ** 2) ** 0.5; alpha = clampa(r - d)
            elif x < r and y > size - r:
                d = ((x - r) ** 2 + (y - (size - r)) ** 2) ** 0.5; alpha = clampa(r - d)
            elif x > size - r and y > size - r:
                d = ((x - (size - r)) ** 2 + (y - (size - r)) ** 2) ** 0.5; alpha = clampa(r - d)
            # 대각 그라데이션
            t = (x + y) / (2 * size)
            col = lerp(C0, C1, t)
            # 삼각형(재생) 마스크
            if in_triangle(x, y, tx0, cy, tw, th):
                col = (255, 255, 255)
            px.extend((col[0], col[1], col[2], alpha))
    raw = bytes(px)
    return encode_png(size, size, raw)

def clampa(v):
    if v >= 1: return 255
    if v <= 0: return 0
    return int(v * 255)

def in_triangle(x, y, x0, cy, tw, th):
    # 왼쪽 변 x0의 위/아래 꼭짓점, 오른쪽 한 점으로 이루어진 삼각형
    top = cy - th / 2
    bot = cy + th / 2
    xr = x0 + tw
    if y < top or y > bot: return False
    frac = (y - top) / (bot - top)
    # 위/아래에서 멀어질수록 오른쪽 한계가 줄어듦(삼각형)
    edge = x0 + tw * (1 - abs(frac - 0.5) * 2)
    return x0 <= x <= edge

def encode_png(w, h, raw):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

os.makedirs("icons", exist_ok=True)
for s in (16, 48, 128):
    with open(f"icons/icon{s}.png", "wb") as f:
        f.write(make_icon(s))
    print(f"icons/icon{s}.png 생성")
