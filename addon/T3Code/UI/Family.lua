-- The family bar, under the open thread's header: the thread it came from (Up) and the
-- threads it started (Kids). Both are buttons, so the controller reaches them.

local _, ns = ...
local UI = ns.UI

local F = {}
ns.Family = F

local BAR_H = 24
local KIDS_MIN_W, KIDS_MAX_W = 110, 260

---------------------------------------------------------------------------
-- Wording

local UP_LEAD = { sub = "Started by:", fork = "Forked from:", side = "Side chat of:" }
local KIDS_NOUN = { sub = "Subagents", fork = "Forks", side = "Side chats", sent = "Sent to other computers" }

local function StatusWord(s)
	if not s then return "" end
	return ns.Color(ns.Store.StatusColor(s), ns.Store.StatusText(s))
end

-- How the open thread came from `up`: "Started by:", "Sent from laptop:", ...
function F.UpLead(up)
	if up.k == "sent" then
		if up.id and up.env then return "Sent from " .. up.env .. ":" end
		return "Sent from another computer:"
	end
	return UP_LEAD[up.k] or UP_LEAD.sub
end

-- "Subagents (31) · 2 working": what the children are, how many, and how many need the
-- player or are still busy.
function F.KidsLabel(kids)
	local kind = kids[1].k
	local need, busy = 0, 0
	for _, kid in ipairs(kids) do
		if kid.k ~= kind then kind = nil end
		if kid.s == "input" or kid.s == "plan" then
			need = need + 1
		elseif kid.s == "working" or kid.s == "waiting" then
			busy = busy + 1
		end
	end
	local text = string.format("%s (%d)", KIDS_NOUN[kind] or "Started here", #kids)
	if need > 0 then
		return text .. ns.Color(ns.Store.StatusColor("input"), string.format(" · %d %s", need, need == 1 and "needs you" or "need you"))
	elseif busy > 0 then
		return text .. ns.Color(ns.Store.StatusColor("working"), string.format(" · %d working", busy))
	end
	return text
end

-- The Kids list: a row per child in the order they started, the status first so a long
-- title can't push it out of sight.
function F.KidsOptions(kids)
	local options = {}
	for _, kid in ipairs(kids) do
		local label = StatusWord(kid.s) .. "  " .. kid.t
		if kid.env then label = label .. ns.Color("grey", "  · " .. kid.env) end
		table.insert(options, { value = kid.id, label = label })
	end
	return options
end

---------------------------------------------------------------------------
-- The bar

function F:Create(right, header)
	local bar = CreateFrame("Frame", nil, right)
	bar:SetPoint("TOPLEFT", header, "BOTTOMLEFT", 0, -3)
	bar:SetPoint("TOPRIGHT", header, "BOTTOMRIGHT", 0, -3)
	bar:SetHeight(BAR_H)
	bar:Hide()
	local line = bar:CreateTexture(nil, "ARTWORK")
	line:SetColorTexture(0.45, 0.36, 0.2, 0.6)
	line:SetHeight(1)
	line:SetPoint("BOTTOMLEFT")
	line:SetPoint("BOTTOMRIGHT")

	local up = CreateFrame("Button", nil, bar)
	up:SetHeight(BAR_H - 2)
	-- A sender on a computer the bridge doesn't know can't be opened, but its tooltip
	-- still says why.
	up:SetMotionScriptsWhileDisabled(true)
	local hl = up:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAtlas("Options_List_Hover")
	hl:SetAllPoints()
	hl:SetAlpha(0.5)
	up.Icon = up:CreateTexture(nil, "ARTWORK")
	up.Icon:SetSize(14, 14)
	up.Icon:SetPoint("LEFT", 4, 0)
	up.Icon:SetAtlas("common-icon-backarrow")
	if not up.Icon:GetAtlas() then up.Icon:SetAtlas("common-dropdown-icon-back") end
	up.Icon:SetRotation(-math.pi / 2)
	up.Text = up:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	up.Text:SetPoint("LEFT", up.Icon, "RIGHT", 6, 0)
	up.Text:SetJustifyH("LEFT")
	up.Text:SetWordWrap(false)
	up.Status = up:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	up.Status:SetPoint("LEFT", up.Text, "RIGHT", 8, 0)
	up:SetScript("OnClick", function(self)
		if not self.target then return end
		PlaySound(SOUNDKIT.IG_QUEST_LOG_OPEN or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		F:Open(self.target, "kids")
	end)
	UI.Tooltip(up, function(self) return self.title end, function(self) return self.tip end)
	up:SetScript("OnSizeChanged", function() F:Fit() end)
	bar.Up = up

	-- Like Snooze: a button that opens the shared list, so it carries what the list
	-- reads from its owner.
	local kids = UI.Button(bar, "", KIDS_MIN_W, function(self) UI.OpenList(self) end)
	kids:SetPoint("RIGHT", -2, 0)
	kids.options = {}
	kids.listWidth = 380
	kids.listAlignRight = true
	kids.Update = function(self) self.value = nil end
	kids.onChange = function(id) F:Open(id, "up") end
	UI.Tooltip(kids, function(self) return self:GetText() end, "Agents this one started. Pick one to open it.")
	bar.Kids = kids

	self.bar = bar
end

-- The status sits right after the title, so cut the title short enough to leave it room.
function F:Fit()
	local up = self.bar.Up
	local width = up:GetWidth() or 0
	if width < 100 then return end -- not laid out yet; OnSizeChanged comes back
	local status = up.Status:GetUnboundedStringWidth() or 0
	local room = width - 24 - (status > 0 and status + 8 or 0) - 6
	up.Text:SetWidth(math.max(40, math.min(up.Text:GetUnboundedStringWidth() or room, room)))
end

-- Show the open thread's relatives, or hide the bar. The conversation hangs under
-- whichever of the bar and the header is lowest.
function F:Refresh()
	local bar = self.bar
	if not bar then return end
	local fam = ns.Main.mode == "thread" and ns.Store:Family() or nil
	local up = fam and fam.up
	local kids = fam and fam.kids and #fam.kids > 0 and fam.kids or nil
	local shown = (up or kids) and true or false
	bar:SetShown(shown)
	ns.Transcript:SetTop(shown and bar or nil)
	if not shown then
		self:LandBack(false)
		return
	end

	local k = bar.Kids
	k:SetShown(kids ~= nil)
	if kids then
		k:SetText(F.KidsLabel(kids))
		k:SetWidth(math.min(KIDS_MAX_W, math.max(KIDS_MIN_W, math.ceil(k:GetTextWidth() or 0) + 28)))
		if k.fam ~= fam then
			k.fam = fam
			k.options = F.KidsOptions(kids)
			local open = UI.ListOpen()
			if open and open.owner == k then UI.RefreshList() end
		end
	end

	local b = bar.Up
	b:SetShown(up ~= nil)
	if up then
		local lead = F.UpLead(up)
		b.target = up.id
		b:SetEnabled(up.id ~= nil)
		b.Icon:SetDesaturated(up.id == nil)
		if up.id then
			b.Text:SetText(ns.Color("gold", lead) .. " " .. up.t)
			b.Status:SetText(StatusWord(up.s))
			b.tip = "Open the agent this one came from."
		else
			b.Text:SetText(ns.Color("grey", lead .. " " .. up.t))
			b.Status:SetText("")
			b.tip = "It came from a computer the bridge doesn't know. Add that computer with t3code-wow env add on your desktop to open it here."
		end
		b.title = up.t
		b:ClearAllPoints()
		b:SetPoint("LEFT", 2, 0)
		if kids then b:SetPoint("RIGHT", k, "LEFT", -8, 0) else b:SetPoint("RIGHT", -2, 0) end
		self:Fit()
	end
	self:LandBack(shown)
end

-- Open relative `id`. `back` names the control that leads back where the player came
-- from: "up" after going down to a child, "kids" after going up to a parent. The
-- controller cursor waits on the message box until the new thread's bar shows it.
function F:Open(id, back)
	self.back = { id = id, to = back }
	ns.Gamepad:Park(ns.Main.composer)
	ns.Main:SelectThread(id)
end

function F:LandBack(shown)
	local back = self.back
	if not back then return end
	if back.id ~= ns.viewId then
		self.back = nil
	elseif shown then
		self.back = nil
		ns.Gamepad:Land(back.to == "up" and self.bar.Up or self.bar.Kids)
	elseif ns.Store:View() then
		-- Its snapshot came with no family to show, so nothing leads back.
		self.back = nil
		ns.Gamepad:Land(nil)
	end
end
