-- A "T3 Code" section styled like the objective tracker: what's running, what needs
-- you, and what just finished. Click a line to open that thread.

local _, ns = ...

local K = {}
ns.Tracker = K

local MAX_LINES = 6
local WIDTH = 260

-- Where the section sits. By default it follows Blizzard's objective tracker as if
-- it were one of its sections: under the last one (Quests, usually), under the
-- "All Objectives" header when that's collapsed, or in the tracker's place when the
-- tracker has nothing to show. It only anchors to the tracker and never runs inside
-- it, so the tracker's secure quest-item buttons stay untouched. Dragging it (after
-- /orca unlock) gives it a spot of its own; "Reset tracker" in Settings brings it back.
local function AttachState()
	local p = ns.db.settings.trackerPoint
	if p then return "custom" end
	local otf = ObjectiveTrackerFrame
	if not otf then return "screen" end
	if not otf:IsShown() then return "replace" end
	if otf.IsCollapsed and otf:IsCollapsed() and otf.Header then return "header" end
	if otf.NineSlice and otf.NineSlice:IsShown() then return "below" end
	return "replace"
end

local function DefaultPoint(frame)
	local state = AttachState()
	K.attached = state
	frame:ClearAllPoints()
	local otf = ObjectiveTrackerFrame
	local width = WIDTH
	if state == "custom" then
		local p = ns.db.settings.trackerPoint
		frame:SetPoint(p[1], UIParent, p[2], p[3], p[4])
	elseif state == "below" then
		frame:SetPoint("TOP", otf.NineSlice, "BOTTOM", 0, -2)
		frame:SetPoint("LEFT", otf, "LEFT", 0, 0)
	elseif state == "header" then
		frame:SetPoint("TOP", otf.Header, "BOTTOM", 0, -6)
		frame:SetPoint("LEFT", otf, "LEFT", 0, 0)
	elseif state == "replace" then
		frame:SetPoint("TOPLEFT", otf, "TOPLEFT", 0, 0)
	else
		frame:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", -320, -220)
	end
	if otf and state ~= "custom" and state ~= "screen" then
		local w = otf:GetWidth()
		if w and w > 120 then width = w end
	end
	frame:SetWidth(width)
end

local function Font(name, fallback)
	return _G[name] and name or fallback
end

-- A line's second row, and the colour of its dot.
local function SubText(t)
	if t.s == "working" then
		return string.format("- %s (%s)", t.l or "Working", ns.Duration(time() - (t.st or time()))), 0.29, 0.62, 1
	elseif t.s == "waiting" then
		return string.format("- %s (%s)", ns.Color("grey", t.l or "Waiting"), ns.Duration(time() - (t.st or time()))), 0.55, 0.6, 0.7
	elseif t.s == "input" or t.s == "plan" then
		return "- " .. ns.Color("orange", t.l or "Needs you"), 1, 0.6, 0.2
	elseif t.s == "failed" then
		return "- " .. ns.Color("red", "Failed"), 1, 0.25, 0.25
	end
	return "- " .. ns.Color("green", "Finished") .. ns.Color("grey", " " .. ns.Ago(t.u)), 0.3, 0.9, 0.3
end

local function CreateLine(parent)
	local b = CreateFrame("Button", nil, parent)
	b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	b.Dot = b:CreateTexture(nil, "ARTWORK")
	b.Dot:SetTexture("Interface\\Buttons\\WHITE8X8")
	b.Dot:SetMask("Interface\\CharacterFrame\\TempPortraitAlphaMask")
	b.Dot:SetSize(8, 8)
	b.Dot:SetPoint("TOPLEFT", 4, -5)
	b.Title = b:CreateFontString(nil, "ARTWORK", Font("ObjectiveTrackerHeaderFont", "GameFontNormalMed2"))
	b.Title:SetPoint("TOPLEFT", 18, 0)
	b.Title:SetPoint("RIGHT", -4, 0)
	b.Title:SetJustifyH("LEFT")
	b.Title:SetWordWrap(false)
	b.Sub = b:CreateFontString(nil, "ARTWORK", Font("ObjectiveTrackerLineFont", "GameFontHighlightSmall"))
	b.Sub:SetPoint("TOPLEFT", b.Title, "BOTTOMLEFT", 0, -2)
	b.Sub:SetPoint("RIGHT", -4, 0)
	b.Sub:SetJustifyH("LEFT")
	b.Sub:SetWordWrap(false)
	b:SetHeight(36)
	b:SetScript("OnEnter", function(self)
		self.Title:SetTextColor(1, 1, 1)
		local t = self.thread
		if not t then return end
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText(t.title, 1, 0.82, 0, 1, true)
		GameTooltip:AddLine(ns.Store:ProjectName(t.p), 0.7, 0.7, 0.7)
		if t.last then GameTooltip:AddLine(t.last, 1, 1, 1, true) end
		GameTooltip:AddLine("Click to open. Right-click to stop showing this workspace here.", 0.5, 0.5, 0.5, true)
		GameTooltip:Show()
	end)
	b:SetScript("OnLeave", function(self)
		self.Title:SetTextColor(OBJECTIVE_TRACKER_COLOR and OBJECTIVE_TRACKER_COLOR.Header.r or 1, OBJECTIVE_TRACKER_COLOR and OBJECTIVE_TRACKER_COLOR.Header.g or 0.82, OBJECTIVE_TRACKER_COLOR and OBJECTIVE_TRACKER_COLOR.Header.b or 0)
		GameTooltip:Hide()
	end)
	b:SetScript("OnClick", function(self, mouse)
		local t = self.thread
		if not t then
			if self.action then self.action() end
			return
		end
		if mouse == "RightButton" then
			K:HideWorkspace(t.p)
			return
		end
		ns.Main:SelectThread(t.id, { show = true })
	end)
	return b
end

function K:Create()
	if self.frame then return end
	local f = CreateFrame("Frame", "OrcaTracker", UIParent)
	f:SetSize(WIDTH, 40)
	f:SetFrameStrata("LOW")
	f:SetClampedToScreen(true)
	f:SetMovable(true)
	self.frame = f

	local header
	if C_AddOns.IsAddOnLoaded("Blizzard_ObjectiveTracker") and ObjectiveTrackerModuleHeaderMixin then
		header = CreateFrame("Frame", nil, f, "ObjectiveTrackerModuleHeaderTemplate")
		header:SetPoint("TOPLEFT", 0, 0)
	else
		header = CreateFrame("Frame", nil, f)
		header:SetSize(WIDTH, 26)
		header:SetPoint("TOPLEFT")
		header.Text = header:CreateFontString(nil, "ARTWORK", "GameFontNormalMed2")
		header.Text:SetPoint("LEFT", 7, 0)
		local line = header:CreateTexture(nil, "ARTWORK")
		line:SetColorTexture(0.8, 0.6, 0.1, 0.8)
		line:SetHeight(1)
		line:SetPoint("BOTTOMLEFT")
		line:SetPoint("BOTTOMRIGHT")
		header.MinimizeButton = CreateFrame("Button", nil, header)
		header.MinimizeButton:SetSize(16, 16)
		header.MinimizeButton:SetPoint("RIGHT", -2, 0)
		header.MinimizeButton:SetNormalAtlas("common-button-list-minus")
		header.MinimizeButton:SetScript("OnClick", function() f:ToggleCollapsed() end)
		function header:SetCollapsed(c)
			self.MinimizeButton:SetNormalAtlas(c and "common-button-list-plus" or "common-button-list-minus")
		end
	end
	header.Text:SetText("Orca")
	header:EnableMouse(true)
	header:RegisterForDrag("LeftButton")
	header:SetScript("OnDragStart", function()
		if not ns.db.settings.trackerLocked then f:StartMoving() end
	end)
	header:SetScript("OnDragStop", function()
		f:StopMovingOrSizing()
		f:SetUserPlaced(false)
		local point, _, rel, x, y = f:GetPoint()
		ns.db.settings.trackerPoint = { point, rel, x, y }
	end)
	header:SetScript("OnMouseUp", function(_, button)
		if button == "LeftButton" and ns.db.settings.trackerLocked then ns.Main:Toggle() end
	end)
	f.Header = header

	-- The module header template calls GetParent():ToggleCollapsed().
	function f:ToggleCollapsed()
		ns.db.settings.trackerCollapsed = not ns.db.settings.trackerCollapsed
		K:Refresh()
	end

	f.Lines = {}
	DefaultPoint(f)
end

-- Workspaces the player keeps out of the tracker (by project id). They still show in
-- the window and still send notices.
function K:HideWorkspace(projectId)
	if not projectId then return end
	local s = ns.db.settings
	s.trackerHidden = s.trackerHidden or {}
	s.trackerHidden[projectId] = ns.Store:ProjectName(projectId) or true
	GameTooltip:Hide()
	ns.Print("Not showing " .. ns.Color("white", ns.Store:ProjectName(projectId)) .. " in the tracker. Right-click one of its agents in the Orca window to show it again.")
	self:Refresh()
end

function K:IsHidden(projectId)
	return projectId ~= nil and (ns.db.settings.trackerHidden or {})[projectId] ~= nil
end

-- From the window's list: stop or start showing a workspace in the tracker.
function K:ToggleWorkspace(projectId)
	if not projectId then return end
	if self:IsHidden(projectId) then
		ns.db.settings.trackerHidden[projectId] = nil
		if next(ns.db.settings.trackerHidden) == nil then ns.db.settings.trackerHidden = nil end
		ns.Print("Showing " .. ns.Color("white", ns.Store:ProjectName(projectId)) .. " in the tracker again.")
		self:Refresh()
	else
		self:HideWorkspace(projectId)
	end
end

function K:HiddenCount()
	local n = 0
	for _ in pairs(ns.db.settings.trackerHidden or {}) do n = n + 1 end
	return n
end

function K:ShowAllWorkspaces()
	ns.db.settings.trackerHidden = nil
	self:Refresh()
end

function K:Refresh(resetPosition)
	if not self.frame then return end
	local f = self.frame
	if resetPosition then DefaultPoint(f) end
	local s = ns.db.settings
	if not s.tracker then
		f:Hide()
		return
	end

	local entries = {}
	local hidden = s.trackerHidden or {}
	-- Not the WoW Assistant (it has the Ask panel), nor workspaces the player hid.
	local function shown(t) return not hidden[t.p or ""] and not ns.Store:IsAssistant(t.id) end
	for _, t in ipairs(ns.Store:Active()) do
		if shown(t) then table.insert(entries, t) end
	end
	for _, t in ipairs(ns.Store.data.threads) do
		if #entries >= MAX_LINES then break end
		if (t.s == "open" or t.s == "failed") and t.un and shown(t) then table.insert(entries, t) end
	end
	local state = ns.Transport:BridgeState()
	self.bridgeState = state
	local notice
	if state == "exhausted" then
		notice = { text = "Live updates paused", sub = "Click to /reload", action = function() ReloadUI() end }
	elseif #entries > 0 and (state == "stale" or state == "t3offline") then
		notice = { text = "Connection lost", sub = state == "stale" and "Is orca-wow running?" or "Orca is offline" }
	end

	if #entries == 0 and not notice and not s.trackerAlways then
		f:Hide()
		return
	end
	f:Show()
	f.Header:SetCollapsed(s.trackerCollapsed and true or false)
	local y = -30
	local shown = 0
	if not s.trackerCollapsed then
		local function Line(i)
			local b = f.Lines[i]
			if not b then
				b = CreateLine(f)
				f.Lines[i] = b
			end
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", 0, y)
			b:SetPoint("RIGHT", f, "RIGHT", 0, 0)
			b:Show()
			y = y - 38
			return b
		end
		for i, t in ipairs(entries) do
			if i > MAX_LINES then break end
			shown = shown + 1
			local b = Line(shown)
			b.thread, b.action = t, nil
			b.Title:SetText(t.title)
			local hc = OBJECTIVE_TRACKER_COLOR and OBJECTIVE_TRACKER_COLOR.Header
			if hc then b.Title:SetTextColor(hc.r, hc.g, hc.b) else b.Title:SetTextColor(1, 0.82, 0) end
			local sub, r, g, bl = SubText(t)
			b.Sub:SetText(sub)
			b.Dot:SetVertexColor(r, g, bl)
		end
		if notice then
			shown = shown + 1
			local b = Line(shown)
			b.thread, b.action = nil, notice.action
			b.Title:SetText(ns.Color("orange", notice.text))
			b.Sub:SetText("- " .. notice.sub)
			b.Dot:SetVertexColor(1, 0.6, 0.2)
		end
	end
	for i = shown + 1, #f.Lines do f.Lines[i]:Hide() end
	f:SetHeight(-y + 4)
end

ns:On("Login", function()
	-- Earlier versions parked the section beside the tracker; start attached once.
	if not ns.db.trackerAttached then
		ns.db.trackerAttached = true
		ns.db.settings.trackerPoint = nil
	end
	K:Create()
	K:Refresh()
end)

-- Follow the tracker when it collapses, empties or comes back. Twice a second is
-- plenty for a collapse the player can see.
C_Timer.NewTicker(0.5, ns.Safe(function()
	if not K.frame then return end
	local otf = ObjectiveTrackerFrame
	local resized = otf and K.attached ~= "custom" and K.attached ~= "screen" and math.abs((otf:GetWidth() or 0) - K.frame:GetWidth()) > 1
	if K.attached ~= AttachState() or resized then DefaultPoint(K.frame) end
end))
ns:On("DataChanged", function() K:Refresh() end)
ns:On("LinkChanged", function() K:Refresh() end)

-- Once a second only the elapsed times change, and the link can go stale on its own
-- clock (no update for a while) with no data arriving to say so. Watch both: the text
-- is cheap, and a state change rebuilds the section so a notice can appear.
function K:RefreshTimers()
	local f = self.frame
	if not f or not f:IsShown() then return end
	local state = ns.Transport:BridgeState()
	if state ~= self.bridgeState then
		self.bridgeState = state
		K:Refresh()
		return
	end
	for _, b in ipairs(f.Lines) do
		if b:IsShown() and b.thread then
			local sub = SubText(b.thread)
			if sub ~= b.Sub:GetText() then b.Sub:SetText(sub) end
		end
	end
end

C_Timer.NewTicker(1, ns.Safe(function()
	if K.frame and K.frame:IsShown() then K:RefreshTimers() end
end))
