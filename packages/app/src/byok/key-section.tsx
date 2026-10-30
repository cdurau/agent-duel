import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArenaByokProvider, ArenaByokStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { arenaByokKey, arenaByokStatusQueryKey, type ArenaByokHost } from "./key";

const PROVIDERS: readonly ArenaByokProvider[] = ["openrouter", "ollama"];

const styles = StyleSheet.create({
  inputRow: {
    alignItems: "flex-start",
  },
  providerRow: {
    flexDirection: "row",
    gap: 8,
  },
});

/** The key belongs to this computer, so a change reaches every connected daemon. */
function connectedHosts(): ArenaByokHost[] {
  const store = getHostRuntimeStore();
  return store.getHosts().flatMap((host) => {
    const client = store.getClient(host.serverId);
    if (!client || !isHostRuntimeConnected(store.getSnapshot(host.serverId))) return [];
    return [{ serverId: host.serverId, client }];
  });
}

function useArenaByokStatus(serverId: string | null): ArenaByokStatus | null {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const query = useFetchQuery({
    queryKey: arenaByokStatusQueryKey(serverId),
    dataShape: "value",
    enabled: Boolean(serverId && client && isConnected),
    staleTimeMs: 0,
    queryFn: () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return client.arenaByokStatus();
    },
  });
  return isConnected ? (query.data ?? null) : null;
}

interface KeyInput {
  draft: string;
  /** Remounts the uncontrolled input to empty it after a save. */
  resetKey: number;
}

function ProviderButton({
  option,
  active,
  disabled,
  onSelect,
}: {
  option: ArenaByokProvider;
  active: boolean;
  disabled: boolean;
  onSelect: (provider: ArenaByokProvider) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(option), [onSelect, option]);
  return (
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      onPress={handlePress}
      disabled={disabled}
      testID={`settings-byok-provider-${option}`}
    >
      {option === "ollama"
        ? t("settings.general.byok.ollama")
        : t("settings.general.byok.openrouter")}
    </Button>
  );
}

/**
 * Rendered only for a daemon without a control plane. The stored key is never read back into
 * the screen; the state shown is whether the daemon holds one for the selected provider.
 */
export function ArenaByokKeySection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useArenaByokStatus(serverId);
  const [provider, setProvider] = useState<ArenaByokProvider>("openrouter");
  const [input, setInput] = useState<KeyInput>({ draft: "", resetKey: 0 });
  const { mutate, isPending, isError, variables } = useMutation({
    mutationFn: (key: string | null) => arenaByokKey.set(key, provider, connectedHosts()),
    onSuccess: (statuses) => {
      for (const host of statuses) {
        queryClient.setQueryData(arenaByokStatusQueryKey(host.serverId), host.status);
      }
      setInput((current) => ({ draft: "", resetKey: current.resetKey + 1 }));
    },
    onError: (error) => {
      console.warn(`[ArenaByok] could not change the ${provider} key`, { error: error.message });
      return queryClient.invalidateQueries({ queryKey: arenaByokStatusQueryKey(serverId) });
    },
  });

  // The daemon reports which provider it holds a key for; a stored key of the other provider is
  // not delivered until its provider is selected.
  const activeProvider: ArenaByokProvider =
    status?.configured && status.provider ? status.provider : provider;
  const configured = activeProvider === provider && status?.configured === true;
  const key = input.draft.trim();

  const handleChangeText = useCallback((draft: string) => {
    setInput((current) => ({ ...current, draft }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!key) return;
    // A new key restarts Arena, which stops every running battle.
    if (configured) {
      const confirmed = await confirmDialog({
        title: t("settings.general.byok.replaceTitle"),
        message: t("settings.general.byok.replaceMessage"),
        confirmLabel: t("settings.general.byok.replace"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    mutate(key);
  }, [configured, key, mutate, t]);

  const handleRemove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.general.byok.removeTitle"),
      message: t("settings.general.byok.removeMessage"),
      confirmLabel: t("settings.general.byok.remove"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    mutate(null);
  }, [mutate, t]);

  if (!status?.available) {
    return null;
  }

  const isRemoving = isPending && variables === null;
  const isSaving = isPending && variables !== null;
  let error: string | null = null;
  if (isError) {
    error =
      variables === null
        ? t("settings.general.byok.removeFailed")
        : t("settings.general.byok.saveFailed");
  }
  const stateLabel = configured
    ? t("settings.general.byok.configured")
    : t("settings.general.byok.notConfigured");
  const removeLabel = isRemoving
    ? t("settings.general.byok.removing")
    : t("settings.general.byok.remove");
  const saveLabel = isSaving ? t("settings.general.byok.saving") : t("settings.general.byok.save");
  const placeholder =
    provider === "ollama"
      ? t("settings.general.byok.ollamaPlaceholder")
      : t("settings.general.byok.openRouterPlaceholder");

  return (
    <SettingsSection title={t("settings.general.byok.title")} testID="settings-byok-key">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} testID="settings-byok-key-state">
              {stateLabel}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {provider === "ollama"
                ? t("settings.general.byok.ollamaDescription")
                : t("settings.general.byok.openRouterDescription")}
            </Text>
          </View>
          {configured ? (
            <Button
              size="sm"
              variant="outline"
              loading={isRemoving}
              disabled={isPending}
              onPress={handleRemove}
              testID="settings-byok-key-remove"
            >
              {removeLabel}
            </Button>
          ) : null}
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.providerRow]}>
          {PROVIDERS.map((option) => (
            <ProviderButton
              key={option}
              option={option}
              active={option === provider}
              disabled={isPending}
              onSelect={setProvider}
            />
          ))}
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.inputRow]}>
          <View style={settingsStyles.rowContent}>
            <FormTextInput
              size="sm"
              resetKey={input.resetKey}
              onChangeText={handleChangeText}
              onSubmitEditing={handleSave}
              placeholder={placeholder}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              editable={!isPending}
              accessibilityLabel={t("settings.general.byok.inputLabel")}
              testID="settings-byok-key-input"
            />
            {error ? (
              <Text style={settingsStyles.rowError} testID="settings-byok-key-error">
                {error}
              </Text>
            ) : null}
          </View>
          <Button
            size="sm"
            variant="outline"
            loading={isSaving}
            disabled={isPending || key.length === 0}
            onPress={handleSave}
            testID="settings-byok-key-save"
          >
            {saveLabel}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
