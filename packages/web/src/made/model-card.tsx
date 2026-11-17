/**
 * The Settings card for a person's own model (docs/platform.md, "Your own
 * model"): which kind of service, its address, the model and the key. The
 * key goes to the server once and is never shown again; leaving the field
 * empty keeps the one saved.
 */
import type { ModelProtocol } from "@hearth/shared";
import { Button, Field, Input, Segmented } from "@hearth/sdk/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Card, CardHeader } from "../components/card";
import { useI18n } from "../session/preferences";
import { MODEL_QUERY_KEY, fetchModelSettings, forgetModelSettings, saveModelSettings } from "./api";

/** What each kind of service usually needs, as a start. */
const PRESETS: Record<ModelProtocol, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
};

export function ModelCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: MODEL_QUERY_KEY, queryFn: ({ signal }) => fetchModelSettings(signal) });
  const [protocol, setProtocol] = useState<ModelProtocol>("openai");
  const [baseUrl, setBaseUrl] = useState(PRESETS.openai.baseUrl);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [done, setDone] = useState(false);

  // What was saved fills the form once it is read.
  useEffect(() => {
    if (!saved.data) return;
    setProtocol(saved.data.protocol);
    setBaseUrl(saved.data.baseUrl);
    setModel(saved.data.model);
  }, [saved.data]);

  const save = useMutation({
    mutationFn: () =>
      saveModelSettings({ protocol, baseUrl, model: model.trim() || PRESETS[protocol].model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
    onSuccess: (settings) => {
      queryClient.setQueryData(MODEL_QUERY_KEY, settings);
      setApiKey("");
      setDone(true);
    },
  });
  const forget = useMutation({
    mutationFn: forgetModelSettings,
    onSuccess: () => {
      queryClient.setQueryData(MODEL_QUERY_KEY, null);
      setApiKey("");
      setModel("");
      setDone(false);
    },
  });

  const choose = (next: ModelProtocol) => {
    // A preset address follows the kind; one the person typed stays.
    if (baseUrl === "" || baseUrl === PRESETS[protocol].baseUrl) setBaseUrl(PRESETS[next].baseUrl);
    setProtocol(next);
    setDone(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    save.mutate();
  };

  return (
    <Card>
      <CardHeader icon={<Bot size={16} aria-hidden="true" />} title={t("model.title")} />
      <p className="mb-4 text-fg-2">{t("model.intro")}</p>
      {saved.isError ? (
        <p role="alert" className="text-down">
          {t("model.loadFailed")}
        </p>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field label={t("model.protocol")} hint={t("model.protocolHint")}>
            <Segmented<ModelProtocol>
              label={t("model.protocol")}
              value={protocol}
              onChange={choose}
              options={[
                { value: "openai", label: t("model.openai") },
                { value: "anthropic", label: t("model.anthropic") },
              ]}
            />
          </Field>
          <Field label={t("model.baseUrl")} hint={t("model.baseUrlHint")}>
            {({ id, hintId }) => (
              <Input
                id={id}
                aria-describedby={hintId}
                type="url"
                required
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setDone(false);
                }}
              />
            )}
          </Field>
          <Field label={t("model.model")} hint={t("model.modelHint", { example: PRESETS[protocol].model })}>
            {({ id, hintId }) => (
              <Input
                id={id}
                aria-describedby={hintId}
                value={model}
                placeholder={PRESETS[protocol].model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setDone(false);
                }}
              />
            )}
          </Field>
          <Field label={t("model.apiKey")} hint={saved.data?.hasKey ? t("model.apiKeySaved") : t("model.apiKeyHint")}>
            {({ id, hintId }) => (
              <Input
                id={id}
                aria-describedby={hintId}
                type="password"
                autoComplete="off"
                value={apiKey}
                required={!saved.data?.hasKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setDone(false);
                }}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t("model.save")}
            </Button>
            {saved.data ? (
              <Button type="button" disabled={forget.isPending} onClick={() => forget.mutate()}>
                {t("model.forget")}
              </Button>
            ) : null}
            <span role="status" className="text-fg-3">
              {done ? t("model.saved") : ""}
            </span>
          </div>
          {save.isError ? (
            <p role="alert" className="text-down">
              {t("model.saveFailed", { detail: save.error instanceof Error ? save.error.message : String(save.error) })}
            </p>
          ) : null}
        </form>
      )}
    </Card>
  );
}
