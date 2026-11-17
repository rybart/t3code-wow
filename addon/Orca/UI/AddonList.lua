-- The game's AddOns list: hide the live-update slot addons (Orca_S###), which
-- would otherwise fill it with over a thousand entries. Only the list's data is
-- filtered; the slots stay enabled and load on demand as before.
--
-- The game rebuilds the list each time it opens and each time an addon is ticked.
-- The slots are removed while the list's data is detached from its scroll box.
-- Removing them while attached made the scroll box redo its layout after every
-- one of the 1,200 removals: a rebuild took 1,943 ms against 12 ms without the
-- filter (measured with AddonList_Update on Forever 1.60.1), and the game froze
-- for two seconds on every tick.

local _, ns = ...

local function SlotNodes(provider)
	local nodes = {}
	for _, node in provider:EnumerateEntireRange() do
		local data = node.GetData and node:GetData() or node
		local name = data.addonIndex and C_AddOns.GetAddOnInfo(data.addonIndex)
		if name and name:match("^Orca_S%d+$") then
			nodes[#nodes + 1] = node
		end
	end
	return nodes
end

local filtering = false

local function HideTransportSlots(scrollBox, provider)
	if filtering or not provider or not provider.EnumerateEntireRange or not provider.Remove then return end
	local nodes = SlotNodes(provider)
	if #nodes == 0 then return end

	local detach = scrollBox.RemoveDataProvider and scrollBox.GetScrollPercentage and scrollBox.SetScrollPercentage
	local scroll = detach and scrollBox:GetScrollPercentage()
	filtering = true
	if detach then scrollBox:RemoveDataProvider() end
	local ok, err = pcall(function()
		for _, node in ipairs(nodes) do provider:Remove(node) end
	end)
	if detach then
		pcall(function()
			scrollBox:SetDataProvider(provider, ScrollBoxConstants and ScrollBoxConstants.RetainScrollPosition)
			scrollBox:SetScrollPercentage(scroll)
		end)
	end
	filtering = false
	if not ok then error(err, 0) end
end

-- Hook the provider assignment so later list rebuilds by other addons are covered.
local hookedScrollBox
local function InstallAddonListFilter()
	local scrollBox = AddonList and AddonList.ScrollBox
	if not scrollBox or hookedScrollBox == scrollBox then return end
	hookedScrollBox = scrollBox
	hooksecurefunc(scrollBox, "SetDataProvider", ns.Safe(function(self, provider)
		HideTransportSlots(self, provider)
	end))
	HideTransportSlots(scrollBox, scrollBox:GetDataProvider())
end

ns:On("Login", InstallAddonListFilter)
ns:RegisterEvent("ADDON_LOADED", InstallAddonListFilter)
