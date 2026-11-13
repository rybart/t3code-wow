-- Strip encryption: ChaCha20 (RFC 8439) and HMAC-SHA-256, so what the strip carries
-- can't be read from a stream or recording, or forged by anything that doesn't have
-- the key. The key arrives through the slot files, which are never on screen.
--
-- Built on the client's 32-bit `bit` library. Every result is normalised with
-- % 2^32, so this works whether the library returns signed numbers (LuaJIT's BitOp,
-- used by the tests) or unsigned ones. Pure Lua 5.1 otherwise; bridge/src/strip-crypto.js
-- is the other end and tools/crypto_test.lua checks the two agree.

local _, ns = ...
ns = ns or {}

local Crypto = {}
ns.Crypto = Crypto

local M = 4294967296
local bitlib = bit
local bxor_, band_, bor_, lshift, rshift = bitlib.bxor, bitlib.band, bitlib.bor, bitlib.lshift, bitlib.rshift
local byte, char, sub, floor, concat = string.byte, string.char, string.sub, math.floor, table.concat
local unpack = unpack or table.unpack

local function bxor(a, b) return bxor_(a, b) % M end
local function band(a, b) return band_(a, b) % M end
local function bor(a, b) return bor_(a, b) % M end
local function rotl(x, s) return bor_(lshift(x, s) % M, rshift(x, 32 - s) % M) % M end
local function rotr(x, s) return bor_(rshift(x, s) % M, lshift(x, 32 - s) % M) % M end

-- Bytes of `s` as a string of chars from a byte table, in chunks (unpack limits).
local function bytesToString(t, n)
	local parts = {}
	for i = 1, n, 4096 do
		parts[#parts + 1] = char(unpack(t, i, math.min(i + 4095, n)))
	end
	return concat(parts)
end

local function wordLE(s, i)
	local a, b, c, d = byte(s, i, i + 3)
	return a + b * 256 + c * 65536 + d * 16777216
end

local function wordBE(s, i)
	local a, b, c, d = byte(s, i, i + 3)
	return d + c * 256 + b * 65536 + a * 16777216
end

---------------------------------------------------------------------------
-- ChaCha20

local function qr(x, a, b, c, d)
	local A, B, C, D = x[a], x[b], x[c], x[d]
	A = (A + B) % M; D = rotl(bxor(D, A), 16)
	C = (C + D) % M; B = rotl(bxor(B, C), 12)
	A = (A + B) % M; D = rotl(bxor(D, A), 8)
	C = (C + D) % M; B = rotl(bxor(B, C), 7)
	x[a], x[b], x[c], x[d] = A, B, C, D
end

-- XOR `data` with the ChaCha20 keystream for a 32-byte key and 12-byte nonce,
-- starting at block `counter` (RFC 8439 uses 1 for messages).
function Crypto.ChaCha20(key, nonce, counter, data)
	assert(#key == 32 and #nonce == 12, "chacha20: bad key or nonce")
	local init = { 0x61707865, 0x3320646e, 0x79622d32, 0x6b206574 }
	for i = 0, 7 do init[5 + i] = wordLE(key, 1 + i * 4) end
	init[13] = counter % M
	for i = 0, 2 do init[14 + i] = wordLE(nonce, 1 + i * 4) end

	local out, n = {}, #data
	local x = {}
	for pos = 1, n, 64 do
		for i = 1, 16 do x[i] = init[i] end
		for _ = 1, 10 do
			qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15); qr(x, 4, 8, 12, 16)
			qr(x, 1, 6, 11, 16); qr(x, 2, 7, 12, 13); qr(x, 3, 8, 9, 14); qr(x, 4, 5, 10, 15)
		end
		local o = pos - 1
		for i = 1, 16 do
			local w = (x[i] + init[i]) % M
			for j = 0, 3 do
				local p = o + (i - 1) * 4 + j + 1
				if p > n then break end
				out[p] = bxor_(byte(data, p), w % 256) % 256
				w = floor(w / 256)
			end
		end
		init[13] = (init[13] + 1) % M
	end
	return bytesToString(out, n)
end

---------------------------------------------------------------------------
-- SHA-256 and HMAC

local K = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local IV = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }

local w = {}
local function compress(H, s, i)
	for t = 1, 16 do w[t] = wordBE(s, i + (t - 1) * 4) end
	for t = 17, 64 do
		local v15, v2 = w[t - 15], w[t - 2]
		local s0 = bxor(bxor(rotr(v15, 7), rotr(v15, 18)), rshift(v15, 3) % M)
		local s1 = bxor(bxor(rotr(v2, 17), rotr(v2, 19)), rshift(v2, 10) % M)
		w[t] = (w[t - 16] + s0 + w[t - 7] + s1) % M
	end
	local a, b, c, d, e, f, g, h = H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]
	for t = 1, 64 do
		local S1 = bxor(bxor(rotr(e, 6), rotr(e, 11)), rotr(e, 25))
		local ch = bxor(g, band(e, bxor(f, g)))
		local t1 = (h + S1 + ch + K[t] + w[t]) % M
		local S0 = bxor(bxor(rotr(a, 2), rotr(a, 13)), rotr(a, 22))
		local maj = bor(band(a, b), band(c, bor(a, b)))
		h, g, f, e, d, c, b, a = g, f, e, (d + t1) % M, c, b, a, (t1 + S0 + maj) % M
	end
	H[1] = (H[1] + a) % M; H[2] = (H[2] + b) % M; H[3] = (H[3] + c) % M; H[4] = (H[4] + d) % M
	H[5] = (H[5] + e) % M; H[6] = (H[6] + f) % M; H[7] = (H[7] + g) % M; H[8] = (H[8] + h) % M
end

local function be32(v)
	return char(floor(v / 16777216) % 256, floor(v / 65536) % 256, floor(v / 256) % 256, v % 256)
end

-- Finish a hash whose state H has already absorbed `prefixLen` bytes (a multiple of 64).
local function finish(H, msg, prefixLen)
	local bits = (prefixLen + #msg) * 8
	local pad = 64 - ((#msg + 9) % 64)
	if pad == 64 then pad = 0 end
	local s = msg .. "\128" .. string.rep("\0", pad) .. be32(floor(bits / M)) .. be32(bits % M)
	for i = 1, #s, 64 do compress(H, s, i) end
	local out = {}
	for i = 1, 8 do out[i] = be32(H[i]) end
	return concat(out)
end

function Crypto.SHA256(msg)
	local H = { unpack(IV) }
	return finish(H, msg, 0)
end

-- Returns a function(msg) -> 32-byte HMAC-SHA-256 digest, with the key's pads
-- absorbed once up front.
function Crypto.HMAC(key)
	if #key > 64 then key = Crypto.SHA256(key) end
	key = key .. string.rep("\0", 64 - #key)
	local ipad, opad = {}, {}
	for i = 1, 64 do
		local k = byte(key, i)
		ipad[i] = bxor_(k, 0x36) % 256
		opad[i] = bxor_(k, 0x5c) % 256
	end
	local Hi, Ho = { unpack(IV) }, { unpack(IV) }
	compress(Hi, char(unpack(ipad)), 1)
	compress(Ho, char(unpack(opad)), 1)
	return function(msg)
		local inner = finish({ unpack(Hi) }, msg, 64)
		return finish({ unpack(Ho) }, inner, 64)
	end
end

function Crypto.FromHex(hex)
	if type(hex) ~= "string" or #hex % 2 ~= 0 or hex:find("[^%x]") then return nil end
	return (hex:gsub("%x%x", function(h) return char(tonumber(h, 16)) end))
end

function Crypto.ToHex(s)
	return (s:gsub(".", function(c) return string.format("%02x", byte(c)) end))
end

return Crypto
