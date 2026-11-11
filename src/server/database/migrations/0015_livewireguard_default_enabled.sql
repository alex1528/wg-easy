-- New installations: enable the LiveWireGuard endpoint by default.
-- Migrations run before the setup, so a fresh database still has setup_step = 1.
-- Existing installations (setup done, setup_step = 0) keep their current value.
UPDATE `general_table` SET `livewireguard_enabled` = true WHERE `setup_step` <> 0;