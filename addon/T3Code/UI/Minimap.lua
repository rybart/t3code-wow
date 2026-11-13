-- Minimap button: click to open or close T3 Code, right-click for settings, drag it
-- around the minimap's edge. Built from the same border and highlight textures as
-- Blizzard's own minimap buttons. A badge shows when a thread needs you.

local _, ns = ...

local B = {}
ns.MinimapButton = B

local function Shape()
	return GetMinimapShape and GetMinimapShape() or "ROUND"
end

-- Place the button on the minimap's edge at `angle` degrees (0 = right, 90 = top).
function B:Place(angle)
	local button = self.button
	local rad = math.rad(angle)
	local x, y = math.cos(rad), math.sin(rad)
	local w = (Minimap:GetWidth() / 2) + 5
	local h = (Minimap:GetHeight() / 2) + 5
	if Shape() ~= "ROUND" then
		-- Square minimaps: push the point out to the square's edge.
		local m = math.max(math.abs(x), math.abs(y))
		if m > 0 then x, y = x / m, y / m end
		w, h = w - 2, h - 2
	end
	button:ClearAllPoints()
	button:SetPoint("CENTER", Minimap, "CENTER", x * w, y * h)
end

local function CursorAngle()
	local mx, my = Minimap:GetCenter()
	local scale = Minimap:GetEffectiveScale()
	local cx, cy = GetCursorPosition()
	cx, cy = cx / scale, cy / scale
	return math.deg(math.atan2(cy - my, cx - mx)) % 360
end

function B:Create()
	if self.button or not Minimap then return end
	local b = CreateFrame("Button", "T3CodeMinimapButton", Minimap)
	b:SetSize(31, 31)
	b:SetFrameStrata("MEDIUM")
	b:SetFrameLevel(Minimap:GetFrameLevel() + 8)
	b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	b:RegisterForDrag("LeftButton")
	b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")

	local bg = b:CreateTexture(nil, "BACKGROUND")
	bg:SetTexture("Interface\\Minimap\\UI-Minimap-Background")
	bg:SetSize(20, 20)
	bg:SetPoint("TOPLEFT", 7, -5)

	local icon = b:CreateTexture(nil, "ARTWORK")
	icon:SetTexture("Interface\\AddOns\\T3Code\\Media\\minimap")
	icon:SetSize(18, 18)
	icon:SetPoint("TOPLEFT", 7, -6)
	b.Icon = icon

	local border = b:CreateTexture(nil, "OVERLAY")
	border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
	border:SetSize(53, 53)
	border:SetPoint("TOPLEFT")

	-- "Needs you" badge.
	local badge = b:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	badge:SetPoint("CENTER", b, "TOPRIGHT", -7, -7)
	badge:SetText("!")
	badge:Hide()
	b.Badge = badge

	b:SetScript("OnClick", function(_, mouse)
		if mouse == "RightButton" then
			ns.Main:Open()
			ns.Main:ShowPage("settings")
		else
			ns.Launcher:Open()
		end
	end)
	b:SetScript("OnDragStart", function(self)
		self:SetScript("OnUpdate", function() B:Place(CursorAngle()) end)
	end)
	b:SetScript("OnDragStop", function(self)
		self:SetScript("OnUpdate", nil)
		ns.db.settings.minimapAngle = CursorAngle()
		B:Place(ns.db.settings.minimapAngle)
	end)
	b:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		B:Tooltip(GameTooltip)
		GameTooltip:Show()
	end)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)

	self.button = b
	self:Place(ns.db.settings.minimapAngle or 215)
	self:Refresh()
end

function B:Tooltip(tip)
	tip:SetText("Orca", 1, 0.82, 0)
	local working, needsYou, waiting = 0, 0, 0
	for _, t in ipairs(ns.Store:Active()) do
		if t.s == "working" then working = working + 1
		elseif t.s == "waiting" then waiting = waiting + 1
		else needsYou = needsYou + 1 end
	end
	if needsYou > 0 then tip:AddLine(needsYou .. (needsYou == 1 and " agent needs you" or " agents need you"), 1, 0.6, 0.2) end
	if working > 0 then tip:AddLine(working .. " working", 0.4, 0.7, 1) end
	if waiting > 0 then tip:AddLine(waiting .. " waiting", 0.6, 0.6, 0.6) end
	if working + needsYou + waiting == 0 then tip:AddLine("Nothing running", 1, 1, 1) end
	local state = ns.Transport:BridgeState()
	if state ~= "connected" then tip:AddLine("Bridge: " .. state, 0.6, 0.6, 0.6) end
	tip:AddLine("Click to open · Right-click for settings · Drag to move", 0.6, 0.6, 0.6)
	if ns.Launcher.chordText then tip:AddLine("Controller: hold " .. ns.Launcher.KeyText("PADLTRIGGER") .. " + " .. ns.Launcher.KeyText("PADRTRIGGER") .. ", press " .. ns.Launcher.KeyText("PADBACK"), 0.6, 0.6, 0.6) end
end

function B:Refresh()
	local b = self.button
	if not b then return end
	b:SetShown(ns.db.settings.minimapButton ~= false)
	local needsYou = false
	for _, t in ipairs(ns.Store:Active()) do
		if t.s == "input" or t.s == "plan" then needsYou = true break end
	end
	b.Badge:SetShown(needsYou)
	b.Icon:SetDesaturated(ns.Transport:BridgeState() ~= "connected")
end

ns:On("Login", function() B:Create() end)
ns:On("DataChanged", function() B:Refresh() end)
ns:On("LinkChanged", function() B:Refresh() end)
