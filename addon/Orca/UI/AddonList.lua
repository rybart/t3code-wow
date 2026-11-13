-- The game's AddOns list: hide the live-update slot addons (Orca_S###), which
-- would otherwise fill it with over a thousand entries. Only the list's data is
-- filtered; the slots stay enabled and load on demand as before.

local _, ns = ...

-- Hook the provider assignment so later list rebuilds by other addons are covered.
local function HideTransportSlots(provider)
	if not provider or not provider.EnumerateEntireRange or not provider.Remove then return end
	local remove = {}
	for _, node in provider:EnumerateEntireRange() do
		local data = node.GetData and node:GetData() or node
		local name = data.addonIndex and C_AddOns.GetAddOnInfo(data.addonIndex)
		if name and name:match("^Orca_S%d+$") then
			remove[#remove + 1] = node
		end
	end
	for _, node in ipairs(remove) do provider:Remove(node) end
end

local hookedScrollBox
local function InstallAddonListFilter()
	local scrollBox = AddonList and AddonList.ScrollBox
	if not scrollBox or hookedScrollBox == scrollBox then return end
	hookedScrollBox = scrollBox
	hooksecurefunc(scrollBox, "SetDataProvider", ns.Safe(function(_, provider)
		HideTransportSlots(provider)
	end))
	HideTransportSlots(scrollBox:GetDataProvider())
end

ns:On("Login", InstallAddonListFilter)
ns:RegisterEvent("ADDON_LOADED", InstallAddonListFilter)
