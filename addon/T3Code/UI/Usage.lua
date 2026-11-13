-- Usage tab: each provider's limits ("Codex · Pro — Weekly 18% used").

local _, ns = ...
local UI = ns.UI

local U = {}
ns.Usage = U

function U:Create(page)
	self.page = page
	local scroll = CreateFrame("ScrollFrame", nil, page, "ScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", 8, -8)
	scroll:SetPoint("BOTTOMRIGHT", -28, 8)
	local content = CreateFrame("Frame", nil, scroll)
	content:SetSize(560, 10)
	scroll:SetScrollChild(content)
	scroll:SetScript("OnSizeChanged", function(_, w) content:SetWidth(w) end)
	self.scroll, self.content = scroll, content
	self.pool = { header = {}, row = {} }
	self.empty = UI.Text(content, "GameFontDisable", "CENTER")
	self.empty:SetPoint("TOP", 0, -40)
	self.empty:SetWidth(500)
end

local function Header(content)
	local h = CreateFrame("Frame", nil, content)
	h:SetHeight(28)
	local bg = h:CreateTexture(nil, "BACKGROUND")
	bg:SetAtlas("common-button-list-collapseExpand")
	bg:SetAllPoints()
	h.Text = h:CreateFontString(nil, "ARTWORK", "Game15Font_Shadow")
	h.Text:SetPoint("CENTER")
	return h
end

local function Row(content)
	local r = CreateFrame("Frame", nil, content)
	r:SetHeight(44)
	r.Label = r:CreateFontString(nil, "ARTWORK", "GameFontHighlightMedium")
	r.Label:SetJustifyH("LEFT")
	r.Label:SetPoint("TOPLEFT", 14, -6)
	r.Sub = r:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
	r.Sub:SetPoint("TOPLEFT", r.Label, "BOTTOMLEFT", 0, -3)
	r.Bar = UI.ProgressBar(r)
	r.Bar:SetSize(260, 24)
	r.Bar:SetPoint("RIGHT", -10, 0)
	r.Value = r:CreateFontString(nil, "ARTWORK", "GameFontHighlightMedium")
	r.Value:SetPoint("RIGHT", -14, 0)
	return r
end

local function ResetText(epoch)
	if not epoch then return "" end
	local days = (epoch - time()) / 86400
	if days < 0 then return "Resetting now" end
	if days < 1 then return "Resets at " .. date("%H:%M", epoch) end
	if days < 7 then return "Resets " .. date("%A at %H:%M", epoch) end
	return "Resets " .. date("%d %b at %H:%M", epoch)
end

function U:Refresh()
	if not self.content then return end
	self.pool.header = self.pool.header or {}
	self.pool.row = self.pool.row or {}
	for _, list in pairs(self.pool) do
		for _, w in ipairs(list) do w:Hide() end
	end
	local used = { header = 0, row = 0 }
	local function Take(kind)
		used[kind] = used[kind] + 1
		local list = self.pool[kind]
		local w = list[used[kind]]
		if not w then
			w = kind == "header" and Header(self.content) or Row(self.content)
			list[used[kind]] = w
		end
		w:ClearAllPoints()
		if kind == "row" then w:SetHeight(44) end
		w:Show()
		return w
	end

	local y = -4
	local usage = ns.Store.data.usage or {}
	for _, p in ipairs(usage) do
		local h = Take("header")
		h:SetPoint("TOPLEFT", 0, y)
		h:SetPoint("RIGHT", self.content, "RIGHT", 0, 0)
		h.Text:SetText(p.plan and (p.name .. "  ·  " .. p.plan) or p.name)
		y = y - 32
		if #p.windows == 0 then
			local r = Take("row")
			r:SetPoint("TOPLEFT", 0, y)
			r:SetPoint("RIGHT", self.content, "RIGHT", 0, 0)
			r.Label:SetText(ns.Color("grey", p.note or "No usage limits reported"))
			r.Label:SetWidth(math.max(300, self.content:GetWidth() - 40))
			r.Sub:SetText(p.checked and ("Checked " .. ns.Ago(p.checked) .. " ago") or "")
			r.Bar:Hide()
			r.Value:SetText("")
			y = y - 46
		else
			for _, w in ipairs(p.windows) do
				local r = Take("row")
				r:SetPoint("TOPLEFT", 0, y)
				r:SetPoint("RIGHT", self.content, "RIGHT", 0, 0)
				r.Label:SetText(w.label)
				r.Label:SetWidth(0) -- auto: a recycled note row may have set it wide
				r.Sub:SetText(ResetText(w.resets))
				r.Bar:Show()
				r.Bar:SetPercent(w.used)
				r.Value:SetText("")
				y = y - 46
			end
		end
		-- Extras from Omarchy's usage records, when present.
		local extras = {}
		if p.credits then table.insert(extras, string.format("Free resets available: %d", p.credits)) end
		if p.today then table.insert(extras, p.today) end
		for _, text in ipairs(extras) do
			local r = Take("row")
			r:SetPoint("TOPLEFT", 0, y)
			r:SetPoint("RIGHT", self.content, "RIGHT", 0, 0)
			r.Label:SetText(ns.Color("grey", text))
			r.Label:SetWidth(0)
			r.Sub:SetText("")
			r.Bar:Hide()
			r.Value:SetText("")
			r:SetHeight(26)
			y = y - 28
		end
		y = y - 10
	end
	self.content:SetHeight(-y + 10)
	if #usage == 0 then
		self.empty:SetText(ns.Store.applied == 0 and "Waiting for the bridge…" or "None of your Orca providers report usage limits right now.")
		self.empty:Show()
	else
		self.empty:Hide()
	end
end

ns:On("DataChanged", function()
	if ns.Main.page == "usage" and ns.Main.frame and ns.Main.frame:IsShown() then U:Refresh() end
end)
