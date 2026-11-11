-- An agent's team must be in the agent's org. A null team_id skips the check (MATCH SIMPLE).
ALTER TABLE "teams" ADD CONSTRAINT "teams_id_org_unique" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_team_same_org_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "public"."teams"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The gateway URL /g/{seller}/{path} names no listing, so a route is unique per seller.
-- endpoints.seller_org_id copies the listing's seller; the trigger below fills it, so
-- inserts can leave it out, and the composite foreign key keeps it equal to the listing's.
ALTER TABLE "listings" ADD CONSTRAINT "listings_id_seller_unique" UNIQUE("id","seller_org_id");--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "seller_org_id" uuid;--> statement-breakpoint
UPDATE "endpoints" SET "seller_org_id" = "listings"."seller_org_id" FROM "listings" WHERE "listings"."id" = "endpoints"."listing_id";--> statement-breakpoint
ALTER TABLE "endpoints" ALTER COLUMN "seller_org_id" SET NOT NULL;--> statement-breakpoint
CREATE FUNCTION fill_endpoint_seller() RETURNS trigger AS $$
BEGIN
  IF NEW.seller_org_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.listing_id IS DISTINCT FROM OLD.listing_id
         AND NEW.seller_org_id IS NOT DISTINCT FROM OLD.seller_org_id) THEN
    SELECT seller_org_id INTO NEW.seller_org_id FROM listings WHERE id = NEW.listing_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER endpoints_fill_seller
  BEFORE INSERT OR UPDATE OF listing_id, seller_org_id ON endpoints
  FOR EACH ROW EXECUTE FUNCTION fill_endpoint_seller();--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_listing_seller_fk" FOREIGN KEY ("listing_id","seller_org_id") REFERENCES "public"."listings"("id","seller_org_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "endpoints_seller_route_unique" ON "endpoints" USING btree ("seller_org_id","method","path_or_tool");--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_rating_range" CHECK ("listings"."rating" between 0 and 5);
