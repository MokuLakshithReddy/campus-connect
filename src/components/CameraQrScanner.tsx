import { useEffect, useRef, useState, useCallback } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { Camera, RefreshCw, AlertCircle, Sparkles, SwitchCamera } from "lucide-react";

interface CameraQrScannerProps {
  onScan: (scannedText: string) => void;
  isProcessing?: boolean;
}

export const CameraQrScanner = ({ onScan, isProcessing = false }: CameraQrScannerProps) => {
  const [scannerActive, setScannerActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scannerContainerId = "html5qr-camera-viewport";

  // Extracts token if QR code contains a JSON payload or URL
  const sanitizeScannedToken = useCallback((raw: string): string => {
    const trimmed = raw.trim();
    // 1. JSON payload check
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed.token || parsed.qr_token || parsed.qr_code_token || parsed.id || trimmed;
      } catch {
        // fallback to trimmed
      }
    }
    // 2. URL or URI scheme check (e.g., https://.../?token=xyz or campus://pass/xyz)
    if (trimmed.includes("token=")) {
      const match = trimmed.match(/token=([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];
    }
    const parts = trimmed.split("/");
    return parts[parts.length - 1] || trimmed;
  }, []);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        scannerRef.current.clear();
      } catch (err) {
        console.warn("Could not cleanly stop QR scanner:", err);
      } finally {
        scannerRef.current = null;
        setScannerActive(false);
      }
    }
  }, []);

  const startScanner = useCallback(async (cameraId?: string) => {
    setCameraError(null);
    await stopScanner();

    try {
      const html5Qr = new Html5Qrcode(scannerContainerId, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      scannerRef.current = html5Qr;

      // Enumerate available video inputs
      try {
        const devices = await Html5Qrcode.getCameras();
        if (devices && devices.length > 0) {
          setCameras(devices);
        }
      } catch (e) {
        // Enumerate error is non-fatal; proceed with facingMode
      }

      const cameraConfig = cameraId
        ? { deviceId: { exact: cameraId } }
        : { facingMode: "environment" };

      await html5Qr.start(
        cameraConfig,
        {
          fps: 15,
          qrbox: { width: 220, height: 220 },
          aspectRatio: 1.0,
        },
        (decodedText) => {
          if (isProcessing) return;
          const cleanToken = sanitizeScannedToken(decodedText);
          if (navigator.vibrate) {
            try {
              navigator.vibrate(80);
            } catch {
              // Ignore vibration failure if unsupported by browser/hardware
            }
          }
          onScan(cleanToken);
        },
        () => {
          // Frame scan errors are intentionally ignored
        }
      );

      setScannerActive(true);
    } catch (err: unknown) {
      const error = err as Error;
      console.error("Camera scanner error:", error);
      setCameraError(
        error.message?.includes("Permission") || error.name === "NotAllowedError"
          ? "Camera permission denied. Please allow camera access in your browser or device settings."
          : "Unable to start camera scanner. Ensure no other application is using the camera."
      );
      setScannerActive(false);
    }
  }, [isProcessing, onScan, sanitizeScannedToken, stopScanner]);

  useEffect(() => {
    startScanner(selectedCameraId || undefined);
    return () => {
      stopScanner();
    };
  }, [selectedCameraId, startScanner, stopScanner]);

  const handleSwitchCamera = () => {
    if (cameras.length <= 1) return;
    const currentIndex = cameras.findIndex((c) => c.id === selectedCameraId);
    const nextIndex = (currentIndex + 1) % cameras.length;
    setSelectedCameraId(cameras[nextIndex].id);
  };

  return (
    <div className="flex flex-col items-center justify-center w-full">
      <div className="relative w-full max-w-[280px] aspect-square rounded-2xl overflow-hidden bg-black/90 border-2 border-primary/40 shadow-inner flex items-center justify-center">
        {/* html5-qrcode container */}
        <div id={scannerContainerId} className="w-full h-full" />

        {/* Viewfinder overlay styling when active */}
        {scannerActive && !cameraError && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            {/* Corner brackets */}
            <div className="relative w-48 h-48 border-2 border-primary/30 rounded-xl overflow-hidden">
              <div className="absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 border-primary rounded-tl" />
              <div className="absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 border-primary rounded-tr" />
              <div className="absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 border-primary rounded-bl" />
              <div className="absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 border-primary rounded-br" />
              
              {/* Laser scan animation line */}
              <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent animate-bounce mt-20 opacity-80" />
            </div>
          </div>
        )}

        {/* Camera Permission / Error state */}
        {cameraError && (
          <div className="absolute inset-0 bg-background/95 p-4 flex flex-col items-center justify-center text-center gap-2 z-20">
            <AlertCircle className="h-8 w-8 text-destructive animate-pulse" />
            <p className="text-xs text-muted-foreground">{cameraError}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => startScanner(selectedCameraId || undefined)}
              className="text-xs mt-1 gap-1"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try Again
            </Button>
          </div>
        )}
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between w-full max-w-[280px] mt-2.5 px-1">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Sparkles className="h-3 w-3 text-primary" /> Point camera at attendee pass
        </span>

        {cameras.length > 1 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleSwitchCamera}
            className="h-7 px-2 text-xs gap-1"
          >
            <SwitchCamera className="h-3.5 w-3.5" /> Flip
          </Button>
        )}
      </div>
    </div>
  );
};

export default CameraQrScanner;
