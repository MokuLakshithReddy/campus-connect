import { useCapacitorBackButton } from "@/hooks/useCapacitorBackButton";

/**
 * Renders null; attaches the native Android hardware back button handler
 * within the React Router DOM tree context.
 */
export const CapacitorBackButtonHandler = () => {
  useCapacitorBackButton();
  return null;
};

export default CapacitorBackButtonHandler;
