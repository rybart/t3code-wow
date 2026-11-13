-- Notices when a thread finishes or needs you: a small gold-bordered toast at the
-- top of the screen, a sound, a chat line, and optionally the reply read aloud.

local _, ns = ...

local N = {}
ns.Toasts = N

local MAX = 3
local WIDTH = 380
local TEXT_W = WIDTH - 62 - 16
local LIFETIME = 7

local function Sound(kind)
	if not ns.db.settings.sounds then return end
	local id
	if kind == "input" then id = SOUNDKIT.READY_CHECK
	elseif kind == "failed" then id = SOUNDKIT.IG_QUEST_FAILED or SOUNDKIT.RAID_WARNING
	else id = SOUNDKIT.IG_QUEST_LIST_COMPLETE end
	if id then PlaySound(id, "Master") end
end

local function CreateToast(i)
	local f = CreateFrame("Button", nil, UIParent, "BackdropTemplate")
	f:SetSize(WIDTH, 64)
	f:SetFrameStrata("DIALOG")
	f:SetBackdrop({
		bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Gold-Border",
		tile = true, tileSize = 32, edgeSize = 24,
		insets = { left = 6, right = 6, top = 6, bottom = 6 },
	})
	f.Icon = f:CreateTexture(nil, "ARTWORK")
	f.Icon:SetSize(40, 40)
	f.Icon:SetPoint("TOPLEFT", 12, -12)
	f.Icon:SetTexture(ns.media .. "portrait")
	f.Title = f:CreateFontString(nil, "ARTWORK", "GameFontNormal")
	f.Title:SetPoint("TOPLEFT", f.Icon, "TOPRIGHT", 10, -2)
	f.Title:SetWidth(TEXT_W)
	f.Title:SetJustifyH("LEFT")
	f.Title:SetWordWrap(false)
	f.Text = f:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	f.Text:SetPoint("TOPLEFT", f.Title, "BOTTOMLEFT", 0, -4)
	f.Text:SetJustifyH("LEFT")
	f.Text:SetMaxLines(4)
	f.Text:SetWidth(TEXT_W)
	f.Text:SetWordWrap(true)
	-- Dismiss without opening anything: the X, or a right-click anywhere on the notice.
	f.Close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	f.Close:SetSize(24, 24)
	f.Close:SetPoint("TOPRIGHT", -3, -3)
	f.Close:SetScript("OnClick", function() f:Hide() end)
	f:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
		GameTooltip:SetText("Click to open, right-click or X to dismiss", 1, 1, 1)
		GameTooltip:Show()
		if self.timer then self.timer:Cancel() end
		self.fade:Stop()
		self:SetAlpha(1)
	end)
	f:SetScript("OnLeave", function(self)
		GameTooltip:Hide()
		self.timer = C_Timer.NewTimer(3, function() if self:IsShown() then self.fade:Play() end end)
	end)
	f:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	f:SetScript("OnClick", function(self, button)
		if button == "LeftButton" and self.threadId then ns.Main:SelectThread(self.threadId, { show = true }) end
		self:Hide()
	end)
	f.fade = f:CreateAnimationGroup()
	local a = f.fade:CreateAnimation("Alpha")
	a:SetFromAlpha(1)
	a:SetToAlpha(0)
	a:SetDuration(0.6)
	f.fade:SetScript("OnFinished", function() f:Hide() end)
	f:SetScript("OnHide", function() N:Layout() end)
	f:Hide()
	return f
end

N.frames = {}

-- The newest notice still on screen, so a shortcut press can open its thread.
function N:VisibleThread()
	local newest
	for _, f in ipairs(self.frames) do
		if f:IsShown() and f.threadId and (not newest or (f.shownAt or 0) > (newest.shownAt or 0)) then newest = f end
	end
	return newest and newest.threadId
end

function N:Layout()
	local y = -120
	for _, f in ipairs(self.frames) do
		if f:IsShown() then
			f:ClearAllPoints()
			f:SetPoint("TOP", UIParent, "TOP", 0, y)
			y = y - f:GetHeight() - 6
		end
	end
end

function N:Show(t, kind)
	local f
	for i = 1, MAX do
		self.frames[i] = self.frames[i] or CreateToast(i)
		if not self.frames[i]:IsShown() then
			f = self.frames[i]
			break
		end
	end
	f = f or self.frames[1]
	f.threadId = t.id
	f.shownAt = GetTime()
	local headline = ({ input = ns.Color("orange", "Needs you"), plan = ns.Color("orange", "Plan ready"),
		failed = ns.Color("red", "Failed"), open = ns.Color("green", "Finished"),
		prfail = ns.Color("red", "PR checks failing"), prpass = ns.Color("green", "PR checks passed"),
		merged = ns.Color("purple", "PR merged"), prready = ns.Color("green", "PR ready to merge") })[kind] or ""
	f.Title:SetText(t.title)
	f.Text:SetText(headline .. ns.Color("grey", "  ·  " .. ns.Store:ProjectName(t.p)) .. (t.last and ("\n" .. t.last) or ""))
	-- Grow the frame to fit the text (up to four lines of the reply).
	local h = 14 + f.Title:GetStringHeight() + 4 + f.Text:GetStringHeight() + 14
	f:SetHeight(math.max(64, math.ceil(h)))
	f.fade:Stop()
	f:SetAlpha(1)
	f:Show()
	self:Layout()
	if f.timer then f.timer:Cancel() end
	f.timer = C_Timer.NewTimer(LIFETIME, function() if f:IsShown() then f.fade:Play() end end)
end

local VERBS = { input = "needs your input", plan = "has a plan ready", failed = "failed", open = "finished" }

N.held = {}

local function Notify(t, kind, quietSound)
	local s = ns.db.settings
	if not quietSound then Sound(kind == "prfail" and "failed" or kind) end
	-- Already on screen: the open window's thread, or the assistant in the Ask panel.
	local viewing = (ns.windowOpen and ns.viewId == t.id) or (ns.AskPanel and ns.AskPanel:Showing() and ns.Store:IsAssistant(t.id))
		or (ns.ChatTab and ns.ChatTab:IsShowingThread(t.id))
	if s.toasts and not viewing then N:Show(t, kind) end
	-- Desktop voice is handled by the bridge (flag "r"); the game's voice here.
	if s.autoRead and ns.SpeechEngine() == "game" and VERBS[kind] then
		ns.Speak(t.title .. " " .. VERBS[kind] .. ". " .. (t.last or ""))
	end
end

ns:On("ThreadTransition", function(t, before, after)
	-- The WoW Assistant stays quiet: its answers show in the Ask panel, and a mark on its
	-- icon says when one came in while the panel was closed.
	if ns.Store:IsAssistant(t.id) then return end
	-- Waiting (on a watched PR, another thread) isn't done yet: tell the player when the wait ends.
	local finished = (before == "working" or before == "waiting") and (after == "open" or after == "failed")
	local needsYou = (after == "input" or after == "plan") and before ~= after
	if not finished and not needsYou then return end
	local kind = after
	ns.Print(ns.Color("white", t.title) .. " " .. VERBS[kind] .. ".")
	if ns.IsQuiet() then
		-- In a fight (or a quiet instance): hold the pop-up and voice until after.
		for i = #N.held, 1, -1 do
			if N.held[i].t.id == t.id then table.remove(N.held, i) end
		end
		table.insert(N.held, { t = t, kind = kind })
		while #N.held > 3 do table.remove(N.held, 1) end
		return
	end
	Notify(t, kind)
end)

-- A workspace's pull request: checks failed or passed, or it merged. Shown on one of its
-- agents, so clicking the notice opens that agent.
local PR_VERBS = { prfail = "has failing checks", prpass = "passed its checks", merged = "was merged", prready = "is ready to merge" }
-- Agents idle longer than this don't make PR notices: their workspaces are old work.
local PR_RECENT = 3 * 24 * 3600

ns:On("PRTransition", function(t, kind)
	if not ns.db.settings.prNotices then return end
	local busy = t.s == "working" or t.s == "waiting" or t.s == "input"
	if not busy and (not t.u or time() - t.u > PR_RECENT) then return end
	-- "Ready to merge" once per PR, ever: the bridge only learns it a little after starting,
	-- so each restart would otherwise say it again.
	if kind == "prready" then
		ns.db.prReadySaid = ns.db.prReadySaid or {}
		if ns.db.prReadySaid[t.pr.n] then return end
		ns.db.prReadySaid[t.pr.n] = time()
		-- Forget ones from long ago.
		for n, at in pairs(ns.db.prReadySaid) do
			if time() - at > 60 * 24 * 3600 then ns.db.prReadySaid[n] = nil end
		end
	end
	ns.Print(string.format("PR #%s (%s) %s.", tostring(t.pr.n), ns.Store:ProjectName(t.p), PR_VERBS[kind]))
	if ns.IsQuiet() then
		table.insert(N.held, { t = t, kind = kind })
		while #N.held > 3 do table.remove(N.held, 1) end
		return
	end
	Notify(t, kind)
end)

-- Logging in (or a /reload): what the agents did meanwhile, in one chat line. Quiet when
-- nothing waits on the player.
ns:On("FirstLive", function()
	-- PRs already ready when the game connects aren't news.
	ns.db.prReadySaid = ns.db.prReadySaid or {}
	for _, t in ipairs(ns.Store.data.threads or {}) do
		if t.pr and t.pr.ok and not ns.db.prReadySaid[t.pr.n] then ns.db.prReadySaid[t.pr.n] = time() end
	end
	if not ns.db.settings.awaySummary then return end
	local finished, needs, working = 0, 0, 0
	for _, t in ipairs(ns.Store.data.threads or {}) do
		if ns.Store:IsAssistant(t.id) then
			-- not one of the player's agents: it has the Ask panel
		elseif t.s == "input" or t.s == "plan" then needs = needs + 1
		elseif t.s == "working" or t.s == "waiting" then working = working + 1
		elseif t.un and (t.s == "open" or t.s == "failed") then finished = finished + 1 end
	end
	if finished == 0 and needs == 0 then return end
	local parts = {}
	if finished > 0 then table.insert(parts, ns.Color("green", finished .. (finished == 1 and " agent finished" or " agents finished"))) end
	if needs > 0 then table.insert(parts, ns.Color("orange", needs .. (needs == 1 and " needs you" or " need you"))) end
	if working > 0 then table.insert(parts, working .. " still working") end
	C_Timer.After(4, function() ns.Print("While you were away: " .. table.concat(parts, ", ") .. ". /orca to see them.") end)
end)

-- Orca changed in a way that may stop replies from the game.
ns:On("BridgeWarning", function(warn)
	ns.Print(ns.Color("orange", warn))
end)

local function Flush()
	if #N.held == 0 or ns.IsQuiet() then return end
	local held = N.held
	N.held = {}
	for i, h in ipairs(held) do
		local current = ns.Store:Thread(h.t.id) or h.t
		-- Only one sound for the batch.
		Notify(current, h.kind, i > 1)
	end
end

ns:On("Combat", function(inCombat) if not inCombat then C_Timer.After(1, Flush) end end)
ns:On("EnteringWorld", function() C_Timer.After(3, Flush) end)
